import { Event, EventEmitter, TreeDataProvider, TreeItem, TreeItemCollapsibleState, Range, Position, workspace } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/lib/main';
import * as ls from 'vscode-languageserver-types';
import { parseUri } from './extension';

export class DataFlowHierarchyNode {
  // These properties come directly from the language server.
  id: number;
  location: ls.Location;
  children: DataFlowHierarchyNode[];
}

export class DataFlowHierarchyProvider implements TreeDataProvider<DataFlowHierarchyNode> {
  root: DataFlowHierarchyNode;
  readonly onDidChangeEmitter: EventEmitter<any> = new EventEmitter<any>();
  readonly onDidChangeTreeData: Event<any> = this.onDidChangeEmitter.event;

  constructor(
    readonly languageClient: LanguageClient, readonly baseDark: string, readonly baseLight: string) { }

  async getTreeItem(element: DataFlowHierarchyNode): Promise<TreeItem> {
    let collapseState = TreeItemCollapsibleState.None;
    if (element.children.length > 0)
      collapseState = TreeItemCollapsibleState.Expanded;

    let light = this.baseLight;
    let dark = this.baseDark;

    let parentFile = await workspace.openTextDocument(parseUri(element.location.uri));
    let label = parentFile.getText(
      new Range(
        new Position(element.location.range.start.line, element.location.range.start.character),
        new Position(element.location.range.end.line, element.location.range.end.character),
      )
    );
    //let label = element.location.uri.toString();
    if (element.location) {
      const path = parseUri(element.location.uri).path;
      const name = path.substr(path.lastIndexOf('/') + 1);
      label += ` (${name}:${element.location.range.start.line + 1})`;
    }

    return {
      collapsibleState: collapseState,
      command: {
        arguments: [element, element.children.length > 0],
        command: 'ccls.hackGotoForTreeView',
        title: 'Goto',
      },
      contextValue: 'cclsGoto',
      iconPath: { light, dark },
      label,
    };
  }

  getChildren(element?: DataFlowHierarchyNode): DataFlowHierarchyNode[] | Thenable<DataFlowHierarchyNode[]> {
    if (!this.root)
      return [];
    if (!element)
      return [this.root];
    return element.children;
  }
}
