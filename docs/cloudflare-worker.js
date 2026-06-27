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

      if (request.method === "GET" && url.pathname.startsWith("/api/download/")) {
        const slug = url.pathname.replace("/api/download/", "").trim();
        return await handleDownload(request, env, slug, url);
      }

      return json({ ok: false, error: "Not found" }, 404);
    } catch (err) {
      return json({ ok: false, error: err.message || "Unknown server error" }, 500);
    }
  },
};

const MAX_FILE_SIZE = 50 * 1024 * 1024;
const RETENTION_LIMITS = {
  7: 50 * 1024 * 1024,
  14: 25 * 1024 * 1024,
  30: 10 * 1024 * 1024,
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function isSafeSlug(slug) {
  return /^[a-z0-9]{8,16}$/.test(slug);
}

function isSafeFileKey(fileKey, slug, extension, retentionDays) {
  const expected = `packs/${retentionDays}d/${slug}.${extension}`;
  return fileKey === expected;
}

function cleanFilename(name) {
  return String(name || "modpack.mrpack")
    .replace(/[^\w.\-() ]+/g, "")
    .slice(0, 120);
}

async function handleUpload(request, env) {
  if (!env.PACKS) return json({ ok: false, error: "R2 binding PACKS is missing." }, 500);

  const formData = await request.formData();
  const file = formData.get("file");
  const slug = String(formData.get("slug") || "").trim();
  const fileKey = String(formData.get("fileKey") || "").trim();
  const retentionDays = Number(formData.get("retentionDays") || 7);

  if (!isSafeSlug(slug)) return json({ ok: false, error: "Invalid slug." }, 400);
  if (!file || typeof file === "string") return json({ ok: false, error: "No file uploaded." }, 400);

  const lower = file.name.toLowerCase();
  const extension = lower.endsWith(".zip") ? "zip" : lower.endsWith(".mrpack") ? "mrpack" : null;
  if (!extension) return json({ ok: false, error: "Only .mrpack and .zip files are allowed." }, 400);

  if (!RETENTION_LIMITS[retentionDays]) {
    return json({ ok: false, error: "Invalid retention option." }, 400);
  }

  if (file.size > MAX_FILE_SIZE) return json({ ok: false, error: "File is larger than 50 MB." }, 400);
  if (file.size > RETENTION_LIMITS[retentionDays]) {
    return json({ ok: false, error: `File is too large for ${retentionDays} day retention.` }, 400);
  }

  if (!isSafeFileKey(fileKey, slug, extension, retentionDays)) {
    return json({ ok: false, error: "Invalid file key." }, 400);
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
    },
  });

  return json({ ok: true, fileKey, size: file.size, name: file.name, extension, retentionDays });
}

async function handleDownload(request, env, slug, url) {
  if (!env.PACKS) return json({ ok: false, error: "R2 binding PACKS is missing." }, 500);
  if (!isSafeSlug(slug)) return json({ ok: false, error: "Invalid slug." }, 400);

  // New links include fileKey so the Worker knows the retention folder and extension.
  // Fallback checks old MVP paths for older uploads.
  const requestedKey = url.searchParams.get("fileKey") || "";
  let candidateKeys = [];

  if (/^packs\/(7|14|30)d\/[a-z0-9]{8,16}\.(mrpack|zip)$/.test(requestedKey) && requestedKey.includes(`/${slug}.`)) {
    candidateKeys.push(requestedKey);
  }

  candidateKeys.push(
    `packs/7d/${slug}.mrpack`,
    `packs/7d/${slug}.zip`,
    `packs/14d/${slug}.mrpack`,
    `packs/14d/${slug}.zip`,
    `packs/30d/${slug}.mrpack`,
    `packs/30d/${slug}.zip`,
    `packs/${slug}.mrpack` // old path fallback
  );

  let object = null;
  let foundKey = null;
  for (const key of [...new Set(candidateKeys)]) {
    object = await env.PACKS.get(key);
    if (object) { foundKey = key; break; }
  }

  if (!object) return json({ ok: false, error: "Pack not found." }, 404);

  const requestedName = url.searchParams.get("name");
  const filename = cleanFilename(requestedName || foundKey.split('/').pop() || `${slug}.mrpack`);

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(object.size),
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=31536000",
      ...corsHeaders(),
    },
  });
}
