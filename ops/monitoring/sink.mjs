// Disposable receiver. Count events without recording notification bodies.
import { createServer } from "node:http";

let sent = 0;
let resolved = 0;
createServer((req, res) => {
  if (req.url === "/health") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ sent, resolved }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/alerts") { res.writeHead(404).end(); return; }
  const chunks = [];
  let size = 0;
  req.on("data", chunk => {
    size += chunk.length;
    if (size > 65536) req.destroy();
    else chunks.push(chunk);
  });
  req.on("end", () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      if (!Array.isArray(payload.alerts)) throw new Error();
      sent += payload.alerts.filter(alert => alert.status === "firing").length;
      resolved += payload.alerts.filter(alert => alert.status === "resolved").length;
      res.writeHead(204).end();
    } catch { res.writeHead(400).end(); }
  });
}).listen(9180, "0.0.0.0");
