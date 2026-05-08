// Pipeline diário: gera relatório + envia por e-mail.
// Em caso de falha (ex: WAF Condfy bloqueando), notifica por e-mail também.
import { spawn } from "node:child_process";
import path from "node:path";

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd: import.meta.dirname,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exit ${code}`));
    });
  });
}

async function notificarFalha(motivo) {
  const { Resend } = await import("resend");
  const apiKey = process.env.RESEND_API_KEY;
  const recipients = (process.env.REPORT_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!apiKey || recipients.length === 0) return;
  const resend = new Resend(apiKey);
  const data = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  await resend.emails.send({
    from: process.env.REPORT_FROM ?? "Protector Sistemas <onboarding@resend.dev>",
    to: recipients[0], // só pra Glauber
    subject: `[FALHA] Relatório ${process.env.REPORT_CLIENT_NAME ?? ""} — ${data}`.trim(),
    html: `<p>O job diário falhou em <code>${data}</code>.</p>
<p><strong>Motivo:</strong></p>
<pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;">${motivo}</pre>
<p>Causas comuns: WAF Condfy bloqueando o IP do runner, sessão JWT
expirada ou controlador Bravas offline. Próxima execução agendada para
amanhã 7h BRT.</p>`,
  });
}

async function main() {
  try {
    console.log("==> 1/2 extract.mjs");
    await run("node", ["extract.mjs"]);
    console.log("\n==> 2/2 send.mjs");
    await run("node", ["send.mjs"]);
    console.log("\n✓ pipeline diário concluído");
  } catch (e) {
    console.error("✗ pipeline falhou:", e.message);
    try {
      await notificarFalha(String(e.stack ?? e.message ?? e));
    } catch (err) {
      console.error("também falhou ao notificar:", err);
    }
    process.exit(1);
  }
}

main();
