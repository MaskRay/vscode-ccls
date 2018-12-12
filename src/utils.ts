import * as path from "path";

export function resourcePath(...paths: string[]): string {
  return path.join(__dirname, "..", "resources", ...paths);
}

export function unwrap<T>(value: T|undefined, tip = "?"): T {
  if (value === undefined)
    throw new Error("undefined " + tip);
  return value;
}
