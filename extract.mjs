// Relatório consolidado Bravas + Condfy
// Granularidade: 1 linha por (pessoa × local liberado)
// Suporta 1+ controladores Bravas (configurados via BRAVAS_CONTROLLERS).
import https from "node:https";
import fs from "node:fs";
import querystring from "node:querystring";
import ExcelJS from "exceljs";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`variável de ambiente obrigatória ausente: ${name}`);
  return v;
}

// BRAVAS_CONTROLLERS: JSON com array dos controladores (nome livre, host, portas).
// Ex: '[{"nome":"A","host":"X.X.X.X","uiPort":8787,"apiPort":8090},
//       {"nome":"B","host":"X.X.X.X","uiPort":8889,"apiPort":8091}]'
const BRAVAS = JSON.parse(requireEnv("BRAVAS_CONTROLLERS"));
const BRAVAS_LOGIN = {
  username: requireEnv("BRAVAS_USER"),
  password: requireEnv("BRAVAS_PASSWORD"),
};
const BRAVAS_CONTROLLER_NAMES = BRAVAS.map((c) => c.nome);

const CONDFY_BASE = "https://api.condfy.com.br/api/cwa/v1";
const CONDFY_LICENSE_ID = Number(requireEnv("CONDFY_LICENSE_ID"));
const CONDFY_AUTH_FILE = "/tmp/condfy-auth.json";
const CONDFY_LOGIN = {
  email: requireEnv("CONDFY_EMAIL"),
  password: requireEnv("CONDFY_PASSWORD"),
};

// ----- httpsRequest com TLS aberto (Bravas usa cert self-signed) -----
function rawRequest({ host, port, path, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const data = body ?? "";
    const finalHeaders = { "User-Agent": UA, ...headers };
    if (data && !finalHeaders["Content-Length"]) {
      finalHeaders["Content-Length"] = String(Buffer.byteLength(data));
    }
    const req = https.request(
      { host, port, path, method, headers: finalHeaders, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ===== BRAVAS =====

async function bravasLogin(c) {
  const body = querystring.stringify(BRAVAS_LOGIN);
  const r = await rawRequest({
    host: c.host,
    port: c.uiPort,
    path: "/login.php",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (r.body.trim() !== "Success") throw new Error(`Login ${c.nome}: ${r.body}`);
  const sid = r.headers["set-cookie"]?.[0].match(/PHPSESSID=([^;]+)/)?.[1];
  if (!sid) throw new Error(`Sem PHPSESSID em ${c.nome}`);
  return sid;
}

async function bravasUiPost(c, sid, path, body = "") {
  const r = await rawRequest({
    host: c.host,
    port: c.uiPort,
    path,
    method: "POST",
    headers: {
      Cookie: `PHPSESSID=${sid}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status}`);
  const j = JSON.parse(r.body);
  if (j.error) throw new Error(`${path}: ${j.message}`);
  return typeof j.data === "string" ? JSON.parse(j.data) : j.data;
}

async function bravasApiPost(c, action, extra = {}) {
  const body = JSON.stringify({ config: { action, ...extra } });
  const r = await rawRequest({
    host: c.host,
    port: c.apiPort,
    path: "/portaria/v1/bravas/config/user/",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (r.status !== 200) throw new Error(`api ${action}: HTTP ${r.status}`);
  const j = JSON.parse(r.body);
  if (j.config?.status === "failed")
    throw new Error(`${action}: ${j.config.reason}`);
  return j;
}

async function coletarBravas(c) {
  console.error(`[${c.nome}] login...`);
  const sid = await bravasLogin(c);

  console.error(`[${c.nome}] grupos...`);
  const groups = await bravasUiPost(c, sid, "/get_groups.php", "");

  const groupAccesses = {};
  for (const g of groups) {
    const det = await bravasUiPost(c, sid, "/get_group.php", `id=${g.Id}`);
    groupAccesses[g.Nome] = Object.keys(det.group_doors_to ?? {});
  }
  console.error(`[${c.nome}] ${groups.length} grupos mapeados`);

  console.error(`[${c.nome}] users (filter all, sem foto)...`);
  const userResp = await bravasApiPost(c, "getUserBatch", {
    page: 1,
    size: 30,
    filter: ["all"],
  });
  const users = userResp.config.users.map((u) => {
    delete u.picture;
    delete u.fingers;
    return u;
  });
  console.error(`[${c.nome}] ${users.length} users`);

  return { c, groupAccesses, users };
}

// ===== CONDFY =====

// estado mutável: cookies em memória, persistido em disco para reaproveitar entre execuções
let condfyCookies = null; // Map<name, value>

function loadCondfyCookies() {
  try {
    const state = JSON.parse(fs.readFileSync(CONDFY_AUTH_FILE, "utf8"));
    const m = new Map();
    for (const c of state.cookies ?? []) {
      if (!c.domain?.includes("condfy.com.br")) continue;
      if (c.value) m.set(c.name, c.value);
    }
    return m;
  } catch {
    return new Map();
  }
}

function persistCondfyCookies() {
  const cookies = [...condfyCookies.entries()].map(([name, value]) => ({
    name,
    value,
    domain: "api.condfy.com.br",
    path: "/",
  }));
  fs.writeFileSync(CONDFY_AUTH_FILE, JSON.stringify({ cookies }, null, 2));
}

function condfyCookieHeader() {
  return [...condfyCookies.entries()]
    .filter(([_, v]) => v)
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
}

function applySetCookie(setCookieList) {
  if (!setCookieList) return;
  const list = Array.isArray(setCookieList) ? setCookieList : [setCookieList];
  for (const sc of list) {
    const m = sc.match(/^([^=]+)=([^;]*)/);
    if (!m) continue;
    condfyCookies.set(m[1].trim(), m[2].trim());
  }
}

function condfyHeaders(extra = {}) {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "pt-BR,pt;q=0.9",
    Origin: "https://web-novo.condfy.com.br",
    Referer: "https://web-novo.condfy.com.br/",
    "User-Agent": UA,
    "sec-ch-ua": '"Chromium";v="147", "Not.A/Brand";v="8"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    Cookie: condfyCookieHeader(),
    "X-XSRF-TOKEN": condfyCookies.get("XSRF-TOKEN") ?? "",
    ...extra,
  };
}

async function condfyEnsureCsrf() {
  const r = await rawRequest({
    host: "api.condfy.com.br",
    port: 443,
    path: "/api/cwa/v1/public/csrf",
    method: "GET",
    headers: condfyHeaders(),
  });
  applySetCookie(r.headers["set-cookie"]);
  if (r.status !== 200) throw new Error(`csrf: HTTP ${r.status}`);
}

async function condfyLogin() {
  console.error("[CONDFY] login completo...");
  await condfyEnsureCsrf();
  const body = JSON.stringify({
    username: CONDFY_LOGIN.email,
    password: CONDFY_LOGIN.password,
    deviceUuid: "7b83327f-14bb-47c5-8bf9-1c2646fa776e",
    defaultUser: false,
  });
  const r = await rawRequest({
    host: "api.condfy.com.br",
    port: 443,
    path: "/api/cwa/v1/public/auth/login",
    method: "POST",
    headers: condfyHeaders({
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    }),
    body,
  });
  applySetCookie(r.headers["set-cookie"]);
  if (r.status !== 200) throw new Error(`login: HTTP ${r.status} ${r.body.substring(0, 200)}`);
  persistCondfyCookies();
  console.error("[CONDFY] login OK");
}

async function condfyRefresh() {
  await condfyEnsureCsrf();
  const r = await rawRequest({
    host: "api.condfy.com.br",
    port: 443,
    path: "/api/cwa/v1/public/auth/refreshToken",
    method: "POST",
    headers: condfyHeaders({ "Content-Type": "application/json", "Content-Length": "2" }),
    body: "{}",
  });
  applySetCookie(r.headers["set-cookie"]);
  if (r.status === 401 || r.status === 403) {
    // refresh token também expirou — re-login
    await condfyLogin();
    return;
  }
  if (r.status !== 200) throw new Error(`refreshToken: HTTP ${r.status} ${r.body.substring(0, 200)}`);
  persistCondfyCookies();
}

async function condfyGet(path, _retry = false) {
  if (!condfyCookies) condfyCookies = loadCondfyCookies();
  if (!condfyCookies.has("csl")) {
    if (condfyCookies.has("rfs")) {
      try { await condfyRefresh(); } catch { await condfyLogin(); }
    } else {
      await condfyLogin();
    }
  }
  const url = new URL(`${CONDFY_BASE}${path}`);
  const r = await rawRequest({
    host: url.hostname,
    port: 443,
    path: url.pathname + url.search,
    method: "GET",
    headers: condfyHeaders(),
  });
  applySetCookie(r.headers["set-cookie"]);
  if ((r.status === 401 || r.status === 403) && !_retry) {
    console.error(`  [auth] HTTP ${r.status}, renovando sessão...`);
    try { await condfyRefresh(); } catch { await condfyLogin(); }
    return condfyGet(path, true);
  }
  if (r.status !== 200)
    throw new Error(`${path}: HTTP ${r.status} ${r.body.substring(0, 200)}`);
  return JSON.parse(r.body);
}

async function coletarCondfyCredenciais() {
  console.error("[CONDFY] credenciais...");
  const all = [];
  let page = 0;
  while (true) {
    const j = await condfyGet(`/licenses/${CONDFY_LICENSE_ID}/credentials?page=${page}`);
    all.push(...j.content);
    if (j.last) break;
    page++;
    if (page % 20 === 0) console.error(`  página ${page}, ${all.length} acumuladas`);
  }
  console.error(`[CONDFY] ${all.length} credenciais total`);
  return all;
}

async function condfyListAllPaginated(path) {
  const all = [];
  let page = 0;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const j = await condfyGet(`${path}${sep}page=${page}&size=30`);
    if (j.content) {
      all.push(...j.content);
      if (j.last) break;
    } else if (Array.isArray(j)) {
      all.push(...j);
      break;
    } else break;
    page++;
    if (page > 50) break; // safety
  }
  return all;
}

async function pMap(items, concurrency, fn) {
  const out = new Array(items.length);
  let i = 0;
  let done = 0;
  const total = items.length;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      done++;
      if (done % Math.max(1, Math.floor(total / 20)) === 0) {
        process.stderr.write(`  ${done}/${total} (${Math.round((done * 100) / total)}%)\r`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write("\n");
  return out;
}

async function coletarCondfyPessoas() {
  console.error("[CONDFY] unidades...");
  const units = await condfyListAllPaginated(
    `/licenses/${CONDFY_LICENSE_ID}/unitsAndBlocks/options?description=`,
  );
  console.error(`[CONDFY] ${units.length} unidades`);

  const tipos = [
    { tipo: "owners", linkType: "PROPRIETARIO" },
    { tipo: "residents", linkType: "MORADOR" },
    { tipo: "serviceProviders", linkType: "PRESTADOR" },
    { tipo: "authorizedVisitors", linkType: "VISITANTE" },
  ];

  const personas = new Map(); // linkId → { tipo, name, serviceType, description, relationshipWithResponsible, ... }
  for (const t of tipos) {
    console.error(`[CONDFY] ${t.tipo} por unidade...`);
    const lists = await pMap(units, 8, (u) =>
      condfyListAllPaginated(`/units/${u.id}/${t.tipo}`).catch(() => []),
    );
    let n = 0;
    for (let i = 0; i < units.length; i++) {
      for (const p of lists[i] ?? []) {
        personas.set(p.id, {
          tipo: t.linkType,
          name: p.name,
          unitId: units[i].id,
          serviceType: p.serviceType ?? null,
          description: p.description ?? null,
          relationshipWithResponsible: p.relationshipWithResponsible ?? null,
          unitRelation: p.unitRelation ?? null,
          accessPeriodsTooltip: p.accessPeriodsTooltip ?? null,
          accessPeriods: p.accessPeriods ?? [],
        });
        n++;
      }
    }
    console.error(`[CONDFY] ${t.tipo}: ${n} pessoas`);
  }
  return personas;
}

async function descobrirConfigToControlador(credentials) {
  // Para cada configurationId, busca o detalhe de uma credencial e identifica
  // o controlador Bravas correspondente pelo nome do equipamento. Faz o match
  // contra os nomes configurados em BRAVAS_CONTROLLERS — se nenhum bater, usa
  // o nome do equipamento como veio da API.
  const map = {};
  const vistos = new Set();
  for (const cred of credentials) {
    if (vistos.has(cred.configurationId)) continue;
    vistos.add(cred.configurationId);
    const det = await condfyGet(`/credentials/${cred.id}/details`);
    const eq = det.equipments?.[0] ?? "";
    const matched = BRAVAS_CONTROLLER_NAMES.find((n) => eq.includes(n));
    map[cred.configurationId] = matched ?? eq;
  }
  return map;
}

async function condfyDetalheTipo(tipo, id) {
  return condfyGet(`/${tipo}/${id}`).catch(() => null);
}

async function enriquecerComNotificacao(personas, linkIdsUsados) {
  console.error(`[CONDFY] detalhe individual (accessNotifications) para ${linkIdsUsados.size} pessoas...`);
  const ids = [...linkIdsUsados];
  const tipoEndpoint = {
    PROPRIETARIO: "owners",
    MORADOR: "residents",
    PRESTADOR: "serviceProviders",
    VISITANTE: "authorizedVisitors",
    SEM_VINCULO: "authorizedVisitors",
  };
  await pMap(ids, 12, async (id) => {
    const p = personas.get(id);
    if (!p) return;
    const endpoint = tipoEndpoint[p.tipo];
    if (!endpoint) return;
    const det = await condfyDetalheTipo(endpoint, id);
    if (det) {
      p.accessNotifications = det.accessNotifications ?? false;
      p.email = det.email ?? null;
      p.cellphone = det.cellphone ?? null;
      p.phone = det.phone ?? null;
    }
  });
  console.error("[CONDFY] enriquecimento concluído");
}

// ===== CRUZAMENTO + EXPLOSÃO =====

function montarLinhas({ bravas, credentials, personas, configToControlador }) {
  // Index Bravas user.name → user (com controlador), por controlador
  const bravasByName = new Map();
  for (const { c, users, groupAccesses } of bravas) {
    for (const u of users) {
      const key = `${c.nome}::${u.name}`;
      bravasByName.set(key, { user: u, controlador: c.nome, groupAccesses });
    }
  }

  const linhas = [];
  let semMatch = 0;
  let veiculos = 0;
  for (const cred of credentials) {
    if (cred.linkTypeDescription === "VEICULO" || cred.credentialTypeDescription === "vehicleRecognition") {
      veiculos++;
      continue;
    }
    // Soma os locais de TODOS os controladores onde a pessoa aparece (mesmo
    // equipmentUserId). Pessoas cadastradas em múltiplos controladores Bravas
    // ganham acesso a regiões físicas distintas — dedup por (linkId × local)
    // ocorre depois.
    const todosMatches = [];
    for (const ctl of BRAVAS_CONTROLLER_NAMES) {
      const m = bravasByName.get(`${ctl}::${cred.equipmentUserId}`);
      if (m) todosMatches.push(m);
    }
    let match = todosMatches[0] ?? null;
    if (!match) {
      semMatch++;
      const p = personas?.get(cred.linkId);
      linhas.push({
        APT: cred.unitNumber ?? "—",
        NOME: cred.linkDescription ?? cred.description,
        TIPO: tipoFromLink(cred.linkTypeDescription),
        DATA_EXPIRA: dataExpira(cred.endDate),
        LOCAL_LIBERADO: "(sem mapeamento Bravas)",
        FACIAL: cred.credentialTypeDescription === "facialRecognition" ? "Sim" : "Não",
        RELACAO:
          p?.serviceType ?? p?.relationshipWithResponsible ?? p?.description ?? "",
        TELEFONE: p?.cellphone || p?.phone ? formatTel(p.cellphone || p.phone) : "",
        NOTIFICAR_ACESSO:
          p?.accessNotifications === true
            ? "Sim"
            : p?.accessNotifications === false
              ? "Não"
              : "",
        PERIODO_LIBERACAO:
          p?.accessPeriodsTooltip && p.accessPeriodsTooltip !== "Sempre liberado"
            ? p.accessPeriodsTooltip
            : "Sempre liberado",
        FABRICANTE: cred.manufacturer === "bravasAutomationAndControl" ? "Bravas" : cred.manufacturer,
        TIPO_DISPOSITIVO: tipoDispositivo(cred.credentialTypeDescription),
      });
      continue;
    }
    // unir locais de TODOS os controladores onde a pessoa existe
    const acessos = todosMatches.flatMap((m) =>
      (m.user.groups ?? []).flatMap((g) => m.groupAccesses[g] ?? []),
    );
    const acessosUnicos = [...new Set(acessos)];
    const u = match.user;

    if (acessosUnicos.length === 0) {
      linhas.push(linhaPessoaLocal(cred, u, "(grupo sem locais)", personas));
      continue;
    }

    for (const local of acessosUnicos) {
      linhas.push(linhaPessoaLocal(cred, u, local, personas));
    }
  }

  // dedup por (linkId × LOCAL_LIBERADO): se a pessoa tem 2 credenciais Condfy
  // (uma por controlador) o passo anterior gera linhas idênticas pros locais
  // somados. Manter apenas a primeira ocorrência preserva FACIAL/TIPO_DISPOSITIVO
  // da credencial principal e evita duplicação.
  const seen = new Set();
  const dedup = [];
  for (const l of linhas) {
    const k = `${l.NOME}::${l.APT}::${l.LOCAL_LIBERADO}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(l);
  }
  return { linhas: dedup, semMatch, veiculos, antesDedup: linhas.length };
}

function linhaPessoaLocal(cred, u, local, personas) {
  const p = personas?.get(cred.linkId);
  const tel =
    p?.cellphone || p?.phone
      ? formatTel(p.cellphone || p.phone)
      : u.info?.phones
        ? `(${u.info.ddd ?? ""}) ${u.info.phones}`.trim()
        : "";
  return {
    APT: u.unit?.add1 ?? cred.unitNumber ?? "—",
    NOME: cred.linkDescription ?? cred.description,
    TIPO: tipoFromLink(cred.linkTypeDescription),
    DATA_EXPIRA: dataExpira(cred.endDate),
    LOCAL_LIBERADO: local,
    FACIAL: cred.credentialTypeDescription === "facialRecognition" ? "Sim" : "Não",
    RELACAO:
      p?.serviceType ??
      p?.relationshipWithResponsible ??
      p?.description ??
      "",
    TELEFONE: tel,
    NOTIFICAR_ACESSO:
      p?.accessNotifications === true
        ? "Sim"
        : p?.accessNotifications === false
          ? "Não"
          : "",
    PERIODO_LIBERACAO: maiorEndDate(p),
    FABRICANTE:
      cred.manufacturer === "bravasAutomationAndControl"
        ? "Bravas"
        : cred.manufacturer,
    TIPO_DISPOSITIVO: tipoDispositivo(cred.credentialTypeDescription),
  };
}

function maiorEndDate(p) {
  // Regra (definida pelo síndico): "Ilimitado" NÃO é data.
  // Se houver qualquer endDate específica entre as janelas, ela vence.
  // "Ilimitado" só aparece quando TODAS as janelas são ilimitadas (endDate vazio)
  // ou quando a pessoa não tem janelas configuradas (sempre liberado).
  const periods = p?.accessPeriods ?? [];
  const datas = periods
    .filter(
      (per) => per.typeDescription === "authorized" || per.typeName === "LIBERACAO",
    )
    .map((per) => per.endDate)
    .filter(Boolean) // descarta endDate null/vazio (= ilimitado dentro daquela janela)
    .sort(); // ISO YYYY-MM-DD ordena cronologicamente
  if (datas.length === 0) return "Ilimitado";
  const maior = datas[datas.length - 1];
  const [y, m, d] = maior.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

function formatTel(t) {
  if (!t) return "";
  const d = String(t).replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return t;
}

function tipoFromLink(t) {
  return (
    {
      MORADOR: "Morador",
      PRESTADOR: "Prestador",
      VISITANTE: "Visitante",
      PROPRIETARIO: "Proprietário",
      VEICULO: "Veículo",
    }[t] ?? t ?? ""
  );
}

function dataExpira(d) {
  if (!d || d === "2099-01-01") return "Ilimitado";
  return d.split("-").reverse().join("/");
}

function tipoDispositivo(t) {
  return (
    {
      facialRecognition: "Reconhecimento Facial",
      vehicleRecognition: "Reconhecimento Veicular",
      tag: "Tag",
      card: "Cartão",
      remoteControl: "Controle Remoto",
      qrCode: "QR Code",
      password: "Senha",
    }[t] ?? t ?? ""
  );
}

// ===== XLSX =====

async function gerarXlsx(linhas, outPath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ProHub Condfy+Bravas Extractor";
  wb.created = new Date();
  const ws = wb.addWorksheet("Cadastros", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = [
    { header: "APT", key: "APT", width: 10 },
    { header: "NOME", key: "NOME", width: 38 },
    { header: "TIPO", key: "TIPO", width: 14 },
    { header: "DATA EXPIRA", key: "DATA_EXPIRA", width: 14 },
    { header: "LOCAL LIBERADO", key: "LOCAL_LIBERADO", width: 32 },
    { header: "FACIAL S/N", key: "FACIAL", width: 10 },
    { header: "RELAÇÃO RESPONSÁVEL", key: "RELACAO", width: 22 },
    { header: "TELEFONE", key: "TELEFONE", width: 18 },
    { header: "NOTIFICAR ACESSO", key: "NOTIFICAR_ACESSO", width: 18 },
    { header: "MAIOR DATA DE LIBERAÇÃO", key: "PERIODO_LIBERACAO", width: 22 },
    { header: "FABRICANTE", key: "FABRICANTE", width: 14 },
    { header: "TIPO DISPOSITIVO", key: "TIPO_DISPOSITIVO", width: 24 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: "middle" };
  ws.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE8EAED" },
  };

  for (const l of linhas) ws.addRow(l);
  ws.autoFilter = { from: "A1", to: "L1" };

  await wb.xlsx.writeFile(outPath);
  console.error(`[XLSX] salvo em ${outPath} (${linhas.length} linhas)`);
}

// ===== MAIN =====

async function main() {
  const tStart = Date.now();
  const [bravas, credentials, personas] = await Promise.all([
    Promise.all(BRAVAS.map(coletarBravas)),
    coletarCondfyCredenciais(),
    coletarCondfyPessoas(),
  ]);

  const linkIdsUsados = new Set(credentials.map((c) => c.linkId).filter(Boolean));
  await enriquecerComNotificacao(personas, linkIdsUsados);

  console.error("[CONDFY] mapping configurationId → controlador...");
  const configToControlador = await descobrirConfigToControlador(credentials);
  console.error(`[CONDFY] mapping: ${JSON.stringify(configToControlador)}`);

  const { linhas, semMatch, veiculos, antesDedup } = montarLinhas({
    bravas,
    credentials,
    personas,
    configToControlador,
  });

  console.error(`\n=== TOTAIS ===`);
  console.error(`Credenciais Condfy:    ${credentials.length}`);
  console.error(`Veículos descartados:  ${veiculos}`);
  console.error(`Sem match Bravas:      ${semMatch}`);
  console.error(`Linhas antes dedup:    ${antesDedup}`);
  console.error(`Linhas geradas:        ${linhas.length}`);
  console.error(`Tempo:              ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

  console.error(`\n=== AMOSTRA (5 primeiras linhas) ===`);
  console.table(linhas.slice(0, 5));

  const out = `relatorio-${Date.now()}.xlsx`;
  await gerarXlsx(linhas, out);
  console.error(`\n→ ${out}`);
}

main().catch((e) => {
  console.error("ERRO:", e);
  process.exit(1);
});
