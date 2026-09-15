import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type ScaffoldOptions = {
  destination: string;
  packageName: string;
  packageVersion: string;
};

export async function scaffoldProject(options: ScaffoldOptions): Promise<void> {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const templateDirectory = join(currentDirectory, "templates", "project");
  await cp(templateDirectory, options.destination, { recursive: true, errorOnExist: true, force: false });
  await replacePlaceholders(options.destination, {
    PACKAGE_NAME: options.packageName,
    PACKAGE_VERSION: options.packageVersion
  });
}

async function replacePlaceholders(directory: string, variables: Record<string, string>): Promise<void> {
  const entries = await readdir(directory);
  for (const entry of entries) {
    const path = join(directory, entry);
    const details = await stat(path);
    if (details.isDirectory()) {
      await replacePlaceholders(path, variables);
      continue;
    }
    const source = await readFile(path, "utf8");
    const next = Object.entries(variables).reduce(
      (result, [key, value]) => result.replaceAll(`{{${key}}}`, value),
      source
    );
    await writeFile(path, next, "utf8");
  }
}
