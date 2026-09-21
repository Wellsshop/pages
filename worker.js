/**
 * Worker de Wellsshop - Catálogo
 * ----------------------------------
 * Este código corre en Cloudflare, NO en el navegador del papá.
 * Es el único lugar donde vive el token de GitHub, así nunca queda
 * expuesto en una página web.
 *
 * Variables/secretos que hay que configurar en Cloudflare (Settings > Variables):
 *   - GITHUB_TOKEN     (secreto) -> Fine-grained PAT con permiso Contents: Read & write
 *   - ADMIN_PASSWORD   (secreto) -> la clave que va a usar tu papá en el panel
 *   - GITHUB_REPO      (texto)   -> "usuario-nuevo/nombre-del-repo"
 *   - GITHUB_BRANCH    (texto)   -> "main"
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function limpiarTexto(texto) {
  return texto
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function githubRequest(env, path, options = {}) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "relojesoscar-catalogo-worker",
      Accept: "application/vnd.github+json",
      ...(options.headers || {}),
    },
  });
  return resp;
}

async function getFile(env, path) {
  const resp = await githubRequest(env, path);
  if (resp.status === 404) return { exists: false, content: null, sha: null };
  if (!resp.ok) throw new Error(`No se pudo leer ${path}: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return { exists: true, sha: data.sha, contentBase64: data.content };
}

async function putFile(env, path, contentBase64, message, sha) {
  const body = {
    message,
    content: contentBase64,
    branch: env.GITHUB_BRANCH || "main",
  };
  if (sha) body.sha = sha;
  const resp = await githubRequest(env, path, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`No se pudo guardar ${path}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function deleteFile(env, path, sha, message) {
  const resp = await githubRequest(env, path, {
    method: "DELETE",
    body: JSON.stringify({ message, sha, branch: env.GITHUB_BRANCH || "main" }),
  });
  return resp.ok;
}

function toBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function fromBase64Utf8(b64) {
  const binary = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function leerProductos(env) {
  const file = await getFile(env, "products.json");
  if (!file.exists) return { productos: [], sha: null };
  const texto = fromBase64Utf8(file.contentBase64);
  return { productos: JSON.parse(texto), sha: file.sha };
}

async function guardarProductos(env, productos, sha, mensaje) {
  const contenido = toBase64Utf8(JSON.stringify(productos, null, 2));
  return putFile(env, "products.json", contenido, mensaje, sha);
}

function checkPassword(env, password) {
  return password && password === env.ADMIN_PASSWORD;
}

async function handleAgregar(request, env) {
  const body = await request.json();
  const { password, nombre, precio, descripcion, categoria, imagenBase64, imagenExt } = body;

  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  if (!nombre || !precio || !imagenBase64) {
    return jsonResponse({ error: "Faltan datos (nombre, precio o imagen)" }, 400);
  }

  const ext = (imagenExt || "jpg").replace(".", "");
  const nombreArchivo = `${limpiarTexto(nombre)}_${Date.now()}.${ext}`;

  // 1) Subir la imagen (archivo nuevo siempre => nunca hay conflicto)
  await putFile(env, `img/${nombreArchivo}`, imagenBase64, `Sube foto: ${nombre}`, null);

  // 2) Agregar la entrada al products.json (con un reintento si alguien más escribió justo antes)
  for (let intento = 0; intento < 2; intento++) {
    const { productos, sha } = await leerProductos(env);
    productos.push({
      imagen: nombreArchivo,
      nombre: String(nombre).trim(),
      precio: isNaN(Number(precio)) ? String(precio) : Number(precio),
      descripcion: String(descripcion || "").trim(),
      categoria: String(categoria || "sin-categoria").trim().toLowerCase(),
    });
    try {
      await guardarProductos(env, productos, sha, `Agregado producto: ${nombre}`);
      return jsonResponse({ ok: true, imagen: nombreArchivo });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo guardar el producto: " + e.message }, 500);
      // si falló por sha desactualizado, reintenta leyendo de nuevo
    }
  }
}

async function handleEliminar(request, env) {
  const body = await request.json();
  const { password, imagen } = body;

  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  if (!imagen) return jsonResponse({ error: "Falta indicar qué producto eliminar" }, 400);

  for (let intento = 0; intento < 2; intento++) {
    const { productos, sha } = await leerProductos(env);
    const nuevaLista = productos.filter((p) => p.imagen !== imagen);
    if (nuevaLista.length === productos.length) {
      return jsonResponse({ error: "No se encontró ese producto" }, 404);
    }
    try {
      await guardarProductos(env, nuevaLista, sha, `Eliminado producto (${imagen})`);
      // borramos también la foto para no acumular archivos sueltos
      const archivoImg = await getFile(env, `img/${imagen}`);
      if (archivoImg.exists) {
        await deleteFile(env, `img/${imagen}`, archivoImg.sha, `Elimina foto: ${imagen}`);
      }
      return jsonResponse({ ok: true });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo eliminar: " + e.message }, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (request.method === "POST" && url.pathname === "/agregar") {
        return await handleAgregar(request, env);
      }
      if (request.method === "POST" && url.pathname === "/eliminar") {
        return await handleEliminar(request, env);
      }
      return jsonResponse({ error: "Ruta no encontrada" }, 404);
    } catch (e) {
      return jsonResponse({ error: "Error inesperado: " + e.message }, 500);
    }
  },
};
