import * as path from "path";
import { Disposable, Uri } from "vscode";

export function resourcePath(...paths: string[]): string {
  return path.join(__dirname, "..", "resources", ...paths);
}

export function unwrap<T>(value: T|undefined, tip = "?"): T {
  if (value === undefined)
    throw new Error("undefined " + tip);
  return value;
}

export function disposeAll(items: Disposable[]): any[] {
  return items.reverse().map((d) => d.dispose());
}

export function normalizeUri(u: string): string {
  return Uri.parse(u).toString(true);
}
