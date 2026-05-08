// Envia o relatório XLSX mais recente para a lista de destinatários via Resend.
// Variáveis de ambiente:
//   RESEND_API_KEY        — chave da API Resend (re_xxx)
//   REPORT_FROM           — remetente "Nome <email@dominio.com>"
//   REPORT_RECIPIENTS     — lista separada por vírgula (ex: a@x.com,b@x.com)
//   REPORT_CLIENT_NAME    — nome do condomínio (aparece no assunto e no corpo)
//   REPORT_SUBJECT        — assunto (default: usa REPORT_CLIENT_NAME e a data)
import fs from "node:fs";
import path from "node:path";
import { Resend } from "resend";

function pegarRelatorioMaisRecente(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("relatorio-") && f.endsWith(".xlsx"))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error("nenhum relatorio-*.xlsx encontrado");
  return path.join(dir, files[0].f);
}

function dataAmigavel() {
  return new Date().toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

async function main() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY ausente");

  const recipients = (process.env.REPORT_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) throw new Error("REPORT_RECIPIENTS ausente");

  const from = process.env.REPORT_FROM ?? "onboarding@resend.dev";
  const cliente = process.env.REPORT_CLIENT_NAME ?? "Condomínio";
  const dataStr = dataAmigavel();
  const subject =
    process.env.REPORT_SUBJECT ??
    `Relatório de Cadastros — ${cliente} — ${dataStr}`;

  const xlsxPath = pegarRelatorioMaisRecente(process.cwd());
  const slug = cliente
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const filename = `cadastros-${slug}-${dataStr.replaceAll("/", "-")}.xlsx`;
  const content = fs.readFileSync(xlsxPath);

  const html = `
<p>Olá,</p>
<p>Segue em anexo o relatório consolidado de cadastros do
condomínio <strong>${cliente}</strong>, com a granularidade de
<em>uma linha por pessoa × local liberado</em>, somando os controladores
de acesso configurados.</p>
<p><strong>Data da extração:</strong> ${dataStr}<br/>
<strong>Arquivo:</strong> ${filename}</p>
<p>Em caso de dúvidas sobre os dados, responda este e-mail e a equipe
técnica retornará.</p>
<p style="color:#888;font-size:12px;margin-top:32px;">
Mensagem automática gerada pelo módulo de auditoria de acesso.
</p>`;

  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send({
    from,
    to: recipients,
    subject,
    html,
    attachments: [{ filename, content }],
  });
  if (error) {
    console.error("Falha ao enviar:", error);
    process.exit(1);
  }
  console.log("Enviado:", data?.id, "→", recipients.join(", "));
  console.log("Anexo:", xlsxPath, `(${content.length} bytes)`);
}

main().catch((e) => {
  console.error("ERRO:", e);
  process.exit(1);
});
