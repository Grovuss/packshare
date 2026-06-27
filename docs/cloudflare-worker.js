export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (request.method === "POST" && url.pathname === "/api/upload") {
        return await handleUpload(request, env);
      }

      if (request.method === "POST" && url.pathname === "/api/resolve-mods") {
        return await handleResolveMods(request, env);
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/download/")) {
        const slug = url.pathname.replace("/api/download/", "").trim();
        return await handleDownload(request, env, slug, url);
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      return json({ ok: false, error: err?.message || "Unknown server error" }, 500);
    }
  },
};

const LIMITS = {
  7: 50 * 1024 * 1024,
  14: 25 * 1024 * 1024,
  30: 10 * 1024 * 1024,
};

function corsHeaders() {
  return {
    // For testing this is easiest. Later change this to your real site:
    // "Access-Control-Allow-Origin": "https://packshare.site",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function isSafeSlug(slug) {
  return /^[a-z0-9]{8,16}$/.test(slug);
}

function isValidExtension(ext) {
  return ext === "mrpack" || ext === "zip";
}

function getExtensionFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".mrpack")) return "mrpack";
  if (lower.endsWith(".zip")) return "zip";
  return "";
}

function cleanFilename(name) {
  return String(name || "modpack.mrpack")
    .replace(/[\r\n"]/g, "")
    .replace(/[^\w.\-() ]+/g, "")
    .slice(0, 120) || "modpack.mrpack";
}

function validFileKeyFor(slug, retentionDays, extension) {
  return `packs/${retentionDays}d/${slug}.${extension}`;
}

function parseAndValidateFileKey(fileKey, slug) {
  const match = String(fileKey || "").match(/^packs\/(7|14|30)d\/([a-z0-9]{8,16})\.(mrpack|zip)$/);
  if (!match) return null;

  const retentionDays = Number(match[1]);
  const keySlug = match[2];
  const extension = match[3];

  if (keySlug !== slug) return null;
  return { retentionDays, extension, fileKey };
}

async function handleUpload(request, env) {
  if (!env.PACKS) {
    return json({ ok: false, error: "R2 binding PACKS is missing." }, 500);
  }

  const formData = await request.formData();
  const file = formData.get("file");
  const slug = String(formData.get("slug") || "").trim();

  if (!isSafeSlug(slug)) {
    return json({ ok: false, error: "Invalid slug." }, 400);
  }

  if (!file || typeof file === "string") {
    return json({ ok: false, error: "No file uploaded." }, 400);
  }

  const extFromName = getExtensionFromName(file.name);
  if (!isValidExtension(extFromName)) {
    return json({ ok: false, error: "Only .mrpack and CurseForge .zip files are allowed." }, 400);
  }

  // New frontend sends fileKey, retentionDays, and extension.
  // This Worker accepts either the explicit fileKey or builds one from retentionDays + extension.
  const requestedFileKey = String(formData.get("fileKey") || "").trim();
  let retentionDays = Number(formData.get("retentionDays") || "7");
  let extension = String(formData.get("extension") || extFromName).toLowerCase();
  let fileKey = requestedFileKey;

  if (requestedFileKey) {
    const parsed = parseAndValidateFileKey(requestedFileKey, slug);
    if (!parsed) {
      return json({ ok: false, error: "Invalid file key." }, 400);
    }
    retentionDays = parsed.retentionDays;
    extension = parsed.extension;
    fileKey = parsed.fileKey;
  } else {
    if (!Object.prototype.hasOwnProperty.call(LIMITS, retentionDays)) {
      return json({ ok: false, error: "Invalid retention option." }, 400);
    }
    if (!isValidExtension(extension)) {
      return json({ ok: false, error: "Invalid extension." }, 400);
    }
    fileKey = validFileKeyFor(slug, retentionDays, extension);
  }

  if (extension !== extFromName) {
    return json({ ok: false, error: "File extension does not match file key." }, 400);
  }

  const maxSize = LIMITS[retentionDays];
  if (file.size > maxSize) {
    return json({
      ok: false,
      error: `File is too large for ${retentionDays} day storage. Max is ${Math.floor(maxSize / 1024 / 1024)} MB.`,
    }, 400);
  }

  await env.PACKS.put(fileKey, file.stream(), {
    httpMetadata: {
      contentType: "application/zip",
      contentDisposition: `attachment; filename="${cleanFilename(file.name)}"`,
    },
    customMetadata: {
      originalName: file.name,
      uploadedAt: String(Date.now()),
      retentionDays: String(retentionDays),
      extension,
      slug,
    },
  });

  return json({
    ok: true,
    fileKey,
    size: file.size,
    name: file.name,
    retentionDays,
    extension,
  });
}

async function handleResolveMods(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const packKind = String(body.packKind || '').toLowerCase();
  const mods = Array.isArray(body.mods) ? body.mods.slice(0, 600) : [];

  if (!mods.length) return json({ ok: true, mods: [] });

  if (packKind === "modrinth") {
    return json({ ok: true, mods: await resolveModrinthMods(mods) });
  }

  if (packKind === "curseforge") {
    return json({ ok: true, mods: await resolveCurseForgeMods(mods, env) });
  }

  return json({ ok: true, mods });
}

async function resolveModrinthMods(mods) {
  const hashes = [];
  const hashForIndex = new Map();

  mods.forEach((mod, index) => {
    const hash = String(mod.sha1 || mod.sha512 || '').trim().toLowerCase();
    if (hash) {
      hashes.push(hash);
      hashForIndex.set(hash, index);
    }
  });

  if (!hashes.length) return mods;

  const algorithm = mods.some(m => m.sha1) ? "sha1" : "sha512";
  const selectedHashes = mods
    .map(m => String(algorithm === "sha1" ? m.sha1 : m.sha512 || '').trim().toLowerCase())
    .filter(Boolean);

  try {
    const versionRes = await fetch("https://api.modrinth.com/v2/version_files", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Packshare/1.0 (packshare.site)",
      },
      body: JSON.stringify({ hashes: selectedHashes, algorithm }),
    });

    if (!versionRes.ok) return mods;
    const versionsByHash = await versionRes.json();
    const projectIds = [...new Set(Object.values(versionsByHash).map(v => v && v.project_id).filter(Boolean))];
    if (!projectIds.length) return mods;

    const projectsUrl = `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(projectIds))}`;
    const projectRes = await fetch(projectsUrl, {
      headers: { "User-Agent": "Packshare/1.0 (packshare.site)" },
    });

    if (!projectRes.ok) return mods;
    const projects = await projectRes.json();
    const projectById = new Map(projects.map(p => [p.id, p]));

    return mods.map(mod => {
      const hash = String(algorithm === "sha1" ? mod.sha1 : mod.sha512 || '').trim().toLowerCase();
      const version = versionsByHash[hash];
      const project = version ? projectById.get(version.project_id) : null;
      if (!project) return mod;

      const projectType = project.project_type || "mod";
      const slug = project.slug || project.id;
      return {
        ...mod,
        name: project.title || mod.name,
        raw: version.name ? `${version.name}` : mod.raw,
        projectId: project.id,
        projectSlug: project.slug || "",
        pageUrl: `https://modrinth.com/${projectType}/${slug}`,
      };
    });
  } catch (_) {
    return mods;
  }
}

async function resolveCurseForgeMods(mods, env) {
  const apiKey = env.CURSEFORGE_API_KEY;
  if (!apiKey) return mods;

  const uniqueIds = [...new Set(mods.map(m => Number(m.projectID)).filter(n => Number.isFinite(n) && n > 0))];
  if (!uniqueIds.length) return mods;

  const resolvedById = new Map();

  // The official API supports GET /v1/mods/{modId}. We use sequential-ish small batches
  // to avoid hammering the API on large packs.
  for (const id of uniqueIds.slice(0, 600)) {
    try {
      const res = await fetch(`https://api.curseforge.com/v1/mods/${id}`, {
        headers: {
          "Accept": "application/json",
          "x-api-key": apiKey,
        },
      });
      if (!res.ok) continue;
      const payload = await res.json();
      const data = payload && payload.data;
      if (data) resolvedById.set(id, data);
    } catch (_) {}
  }

  return mods.map(mod => {
    const id = Number(mod.projectID);
    const data = resolvedById.get(id);
    if (!data) return mod;

    return {
      ...mod,
      name: data.name || mod.name,
      raw: mod.fileID ? `File ${mod.fileID}` : mod.raw,
      pageUrl: (data.links && data.links.websiteUrl) || mod.pageUrl || "",
      slug: data.slug || "",
    };
  });
}

async function handleDownload(request, env, slug, url) {
  if (!env.PACKS) {
    return json({ ok: false, error: "R2 binding PACKS is missing." }, 500);
  }

  if (!isSafeSlug(slug)) {
    return json({ ok: false, error: "Invalid slug." }, 400);
  }

  const requestedKey = url.searchParams.get("key") || url.searchParams.get("fileKey");
  let fileKey = "";
  let object = null;

  if (requestedKey) {
    const parsed = parseAndValidateFileKey(requestedKey, slug);
    if (!parsed) {
      return json({ ok: false, error: "Invalid file key." }, 400);
    }
    fileKey = parsed.fileKey;
    object = await env.PACKS.get(fileKey);
  } else {
    // Backwards-compatible fallback: try every valid retention/ext path.
    const possibleKeys = [
      `packs/7d/${slug}.mrpack`,
      `packs/7d/${slug}.zip`,
      `packs/14d/${slug}.mrpack`,
      `packs/14d/${slug}.zip`,
      `packs/30d/${slug}.mrpack`,
      `packs/30d/${slug}.zip`,
      // Older first version path support:
      `packs/${slug}.mrpack`,
    ];

    for (const key of possibleKeys) {
      const found = await env.PACKS.get(key);
      if (found) {
        fileKey = key;
        object = found;
        break;
      }
    }
  }

  if (!object) {
    return json({ ok: false, error: "Pack not found." }, 404);
  }

  const requestedName = url.searchParams.get("name");
  const fallbackExt = fileKey.endsWith(".zip") ? "zip" : "mrpack";
  const filename = cleanFilename(requestedName || `${slug}.${fallbackExt}`);

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=3600",
      ...corsHeaders(),
    },
  });
}
