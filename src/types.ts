import { Uri } from 'vscode';
import * as ls from 'vscode-languageserver-types';

export interface Icon {
  light: string | Uri;
  dark: string | Uri;
}

export interface ClientConfig {
  cache: {
    directory: string,
  };
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

export interface IHierarchyNode {
  id: any;
  name: string;
  location: ls.Location;
  numChildren: number;
  children: IHierarchyNode[];
}
