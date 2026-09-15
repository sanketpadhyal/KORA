import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist/templates", { recursive: true, force: true });
await mkdir("dist/templates", { recursive: true });
await cp("templates", "dist/templates", { recursive: true });
