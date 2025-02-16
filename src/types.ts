import { Uri } from 'vscode';
import * as ls from 'vscode-languageserver-types';

export interface Icon {
  light: string | Uri;
  dark: string | Uri;
}

export interface ClientConfig {
  highlight: {
    blacklist: string[];
    lsRanges: boolean;
    rainbow: number;
  };
  launchArgs: string[];
  launchCommand: string;
  statusUpdateInterval: number;
  traceEndpoint: string;
  [key: string]: any;
}

export interface IHierarchyNode {
  id: any;
  name: string;
  location: ls.Location;
  numChildren: number;
  children: IHierarchyNode[];
}
