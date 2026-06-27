export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
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

function corsHeaders() {
  return {
    // For testing, * is easiest. Later, change to https://packshare.site
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

function cleanFilename(name) {
  return String(name || "modpack.mrpack")
    .replace(/[^\w.\-() ]+/g, "")
    .slice(0, 120);
}

async function handleUpload(request, env) {
  const formData = await request.formData();
  const file = formData.get("file");
  const slug = String(formData.get("slug") || "").trim();

  if (!env.PACKS) return json({ ok: false, error: "R2 binding PACKS is missing." }, 500);
  if (!isSafeSlug(slug)) return json({ ok: false, error: "Invalid slug." }, 400);
  if (!file || typeof file === "string") return json({ ok: false, error: "No file uploaded." }, 400);
  if (!file.name.toLowerCase().endsWith(".mrpack")) return json({ ok: false, error: "Only .mrpack files are allowed." }, 400);
  if (file.size > MAX_FILE_SIZE) return json({ ok: false, error: "File is larger than 50 MB." }, 400);

  const fileKey = `packs/${slug}.mrpack`;

  await env.PACKS.put(fileKey, file.stream(), {
    httpMetadata: {
      contentType: "application/zip",
      contentDisposition: `attachment; filename="${cleanFilename(file.name)}"`,
    },
    customMetadata: {
      originalName: file.name,
      uploadedAt: String(Date.now()),
    },
  });

  return json({ ok: true, fileKey, size: file.size, name: file.name });
}

async function handleDownload(request, env, slug, url) {
  if (!env.PACKS) return json({ ok: false, error: "R2 binding PACKS is missing." }, 500);
  if (!isSafeSlug(slug)) return json({ ok: false, error: "Invalid slug." }, 400);

  const fileKey = `packs/${slug}.mrpack`;
  const object = await env.PACKS.get(fileKey);
  if (!object) return json({ ok: false, error: "Pack not found." }, 404);

  const requestedName = url.searchParams.get("name");
  const filename = cleanFilename(requestedName || `${slug}.mrpack`);

  return new Response(object.body, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": object.size,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=31536000",
      ...corsHeaders(),
    },
  });
}
