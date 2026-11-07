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

const MAX_FOTOS = 8;
const idDe = (p) => p.id || p.imagen;
const fotosDe = (p) => (Array.isArray(p.imagenes) && p.imagenes.length ? p.imagenes : p.imagen ? [p.imagen] : []);

async function subirFotos(env, nombre, fotos) {
  const nombres = [];
  for (let i = 0; i < fotos.length; i++) {
    const ext = String(fotos[i].ext || "jpg").replace(".", "").toLowerCase();
    const archivo = `${limpiarTexto(nombre)}_${Date.now()}_${i}.${ext}`;
    await putFile(env, `img/${archivo}`, fotos[i].base64, `Sube foto: ${nombre}`, null);
    nombres.push(archivo);
  }
  return nombres;
}

async function borrarFotos(env, archivos) {
  for (const a of archivos) {
    try {
      const f = await getFile(env, `img/${a}`);
      if (f.exists) await deleteFile(env, `img/${a}`, f.sha, `Elimina foto: ${a}`);
    } catch (_) {}
  }
}

async function handleProductos(env) {
  const { productos } = await leerProductos(env);
  return jsonResponse(productos);
}

async function handleAgregar(request, env) {
  const body = await request.json();
  const { password, nombre, precio, descripcion, categoria, marca } = body;
  const fotos = Array.isArray(body.fotos) ? body.fotos : body.imagenBase64 ? [{ base64: body.imagenBase64, ext: body.imagenExt }] : [];

  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  if (!nombre || !precio || fotos.length === 0) return jsonResponse({ error: "Faltan datos (nombre, precio o fotos)" }, 400);
  if (fotos.length > MAX_FOTOS) return jsonResponse({ error: `Máximo ${MAX_FOTOS} fotos por producto` }, 400);

  const nombres = await subirFotos(env, nombre, fotos);

  for (let intento = 0; intento < 2; intento++) {
    const { productos, sha } = await leerProductos(env);
    productos.push({
      id: nombres[0],
      imagen: nombres[0],
      imagenes: nombres,
      nombre: String(nombre).trim(),
      precio: isNaN(Number(precio)) ? String(precio) : Number(precio),
      descripcion: String(descripcion || "").trim(),
      categoria: String(categoria || "sin-categoria").trim().toLowerCase(),
      marca: String(marca || "").trim(),
    });
    try {
      await guardarProductos(env, productos, sha, `Agregado producto: ${nombre}`);
      return jsonResponse({ ok: true, imagen: nombres[0] });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo guardar el producto: " + e.message }, 500);
    }
  }
}

async function handleEditar(request, env) {
  const body = await request.json();
  const { password, id, nombre, precio, descripcion, categoria, marca, orden } = body;
  const fotosNuevas = Array.isArray(body.fotosNuevas) ? body.fotosNuevas : [];

  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  if (!id || !nombre || !precio) return jsonResponse({ error: "Faltan datos (nombre o precio)" }, 400);
  if (!Array.isArray(orden) || orden.length === 0) return jsonResponse({ error: "El producto necesita al menos una foto" }, 400);
  if (orden.length > MAX_FOTOS) return jsonResponse({ error: `Máximo ${MAX_FOTOS} fotos por producto` }, 400);

  const nuevas = await subirFotos(env, nombre, fotosNuevas);

  for (let intento = 0; intento < 2; intento++) {
    const { productos, sha } = await leerProductos(env);
    const i = productos.findIndex((p) => idDe(p) === id);
    if (i < 0) return jsonResponse({ error: "No se encontró ese producto" }, 404);

    const p = productos[i];
    const actuales = fotosDe(p);
    // "orden" mezcla fotos existentes (nombre de archivo) y nuevas ("nuevo:0", "nuevo:1"...)
    const finales = orden
      .map((o) => (String(o).startsWith("nuevo:") ? nuevas[Number(o.slice(6))] : actuales.includes(o) ? o : null))
      .filter(Boolean);
    if (finales.length === 0) return jsonResponse({ error: "El producto necesita al menos una foto" }, 400);

    productos[i] = {
      ...p,
      id: idDe(p),
      imagen: finales[0],
      imagenes: finales,
      nombre: String(nombre).trim(),
      precio: isNaN(Number(precio)) ? String(precio) : Number(precio),
      descripcion: String(descripcion || "").trim(),
      categoria: String(categoria || p.categoria || "sin-categoria").trim().toLowerCase(),
      marca: String(marca ?? p.marca ?? "").trim(),
    };
    try {
      await guardarProductos(env, productos, sha, `Editado producto: ${nombre}`);
      await borrarFotos(env, actuales.filter((f) => !finales.includes(f)));
      return jsonResponse({ ok: true });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo guardar los cambios: " + e.message }, 500);
    }
  }
}

// ---------- Logos de marcas ----------
// Los logos se guardan en img/marcas/ y el listado (marca -> archivo) en marcas.json
const slugMarca = (m) => limpiarTexto(String(m || "")).replace(/_/g, "-");

async function leerMarcas(env) {
  const file = await getFile(env, "marcas.json");
  if (!file.exists) return { marcas: {}, sha: null };
  return { marcas: JSON.parse(fromBase64Utf8(file.contentBase64)), sha: file.sha };
}

async function guardarMarcas(env, marcas, sha, mensaje) {
  return putFile(env, "marcas.json", toBase64Utf8(JSON.stringify(marcas, null, 2)), mensaje, sha);
}

async function handleMarcas(env) {
  const { marcas } = await leerMarcas(env);
  return jsonResponse(marcas);
}

async function handleLogo(request, env) {
  const { password, marca, base64, ext } = await request.json();
  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  const slug = slugMarca(marca);
  if (!slug || !base64) return jsonResponse({ error: "Faltan datos (marca o logo)" }, 400);
  const extension = String(ext || "png").replace(".", "").toLowerCase();
  if (!["png", "jpg", "jpeg", "webp"].includes(extension)) return jsonResponse({ error: "Formato de imagen no permitido" }, 400);

  const archivo = `marcas/${slug}_${Date.now()}.${extension}`;
  await putFile(env, `img/${archivo}`, base64, `Logo de marca: ${marca}`, null);

  for (let intento = 0; intento < 2; intento++) {
    const { marcas, sha } = await leerMarcas(env);
    const anterior = marcas[slug];
    marcas[slug] = archivo;
    try {
      await guardarMarcas(env, marcas, sha, `Logo de marca: ${marca}`);
      if (anterior && anterior !== archivo) await borrarFotos(env, [anterior]);
      return jsonResponse({ ok: true, archivo });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo guardar el logo: " + e.message }, 500);
    }
  }
}

async function handleLogoEliminar(request, env) {
  const { password, marca } = await request.json();
  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  const slug = slugMarca(marca);
  if (!slug) return jsonResponse({ error: "Falta indicar la marca" }, 400);

  for (let intento = 0; intento < 2; intento++) {
    const { marcas, sha } = await leerMarcas(env);
    const archivo = marcas[slug];
    if (!archivo) return jsonResponse({ ok: true });
    delete marcas[slug];
    try {
      await guardarMarcas(env, marcas, sha, `Quita logo de marca: ${marca}`);
      await borrarFotos(env, [archivo]);
      return jsonResponse({ ok: true });
    } catch (e) {
      if (intento === 1) return jsonResponse({ error: "No se pudo quitar el logo: " + e.message }, 500);
    }
  }
}

async function handleVerificar(request, env) {
  const body = await request.json();
  const { password } = body;
  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  return jsonResponse({ ok: true });
}

async function handleEliminar(request, env) {
  const body = await request.json();
  const { password } = body;
  const id = body.id || body.imagen;

  if (!checkPassword(env, password)) return jsonResponse({ error: "Clave incorrecta" }, 401);
  if (!id) return jsonResponse({ error: "Falta indicar qué producto eliminar" }, 400);

  for (let intento = 0; intento < 2; intento++) {
    const { productos, sha } = await leerProductos(env);
    const borrado = productos.find((p) => idDe(p) === id || p.imagen === id);
    if (!borrado) return jsonResponse({ error: "No se encontró ese producto" }, 404);
    const nuevaLista = productos.filter((p) => p !== borrado);
    try {
      await guardarProductos(env, nuevaLista, sha, `Eliminado producto (${id})`);
      await borrarFotos(env, fotosDe(borrado));
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
      if (request.method === "POST" && url.pathname === "/verificar") {
        return await handleVerificar(request, env);
      }
      if (request.method === "POST" && url.pathname === "/agregar") {
        return await handleAgregar(request, env);
      }
      if (request.method === "POST" && url.pathname === "/editar") {
        return await handleEditar(request, env);
      }
      if (request.method === "GET" && url.pathname === "/productos") {
        return await handleProductos(env);
      }
      if (request.method === "GET" && url.pathname === "/marcas") {
        return await handleMarcas(env);
      }
      if (request.method === "POST" && url.pathname === "/logo") {
        return await handleLogo(request, env);
      }
      if (request.method === "POST" && url.pathname === "/logo-eliminar") {
        return await handleLogoEliminar(request, env);
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
