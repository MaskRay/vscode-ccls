import { Uri } from "vscode";

export interface Icon {
  light: string | Uri;
  dark: string | Uri;
}

export interface ClientConfig {
  cacheDirectory: string;
  highlight: {
    enabled: boolean;
    lsRanges: boolean;
  };
  launchArgs: string[];
  launchCommand: string;
  workspaceSymbol: {
    sort: boolean,
  };
  statusUpdateInterval: number;
  [key: string]: any;
}
