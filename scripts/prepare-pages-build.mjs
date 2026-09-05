import { cp, mkdir, rm, access, writeFile } from "node:fs/promises";

const from = new URL("../dist/client/", import.meta.url);
const to = new URL("../dist/pages/", import.meta.url);
await access(new URL("index.html", from));
await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
await cp(new URL("../pages/worker.js", import.meta.url), new URL("_worker.js", to));
await writeFile(new URL("_routes.json", to), JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }) + "\n");
console.log("Prepared Pages frontend and existing-Worker service binding gateway.");
