import {
  Position,
  TreeItem,
  Uri
} from "vscode";
import { LanguageClient } from "vscode-languageclient/lib/main";
import { Hierarchy } from "./hierarchies/hierarchy";
import { IHierarchyNode } from "./types";

function InheritanceHierarchySetWantsDerived(node: InheritanceHierarchyNode, value: boolean) {
  node.wantsDerived = value;
  node.children.map((c) => InheritanceHierarchySetWantsDerived(c, value));
}

interface InheritanceHierarchyNode extends IHierarchyNode {
  children: InheritanceHierarchyNode[];
  kind: number;

  /** If true and children need to be expanded derived will be used, otherwise base will be used. */
  wantsDerived: boolean;
  isBaseLabel?: boolean;
}

export class InheritanceHierarchyProvider extends Hierarchy<InheritanceHierarchyNode> {
  protected contextValue: string = 'extension.ccls.inheritanceHierarchyVisible';

  constructor(readonly languageClient: LanguageClient) {
    super(languageClient, 'ccls.inheritanceHierarchy', 'ccls.closeInheritanceHierarchy');
  }

  public onTreeItem(ti: TreeItem, element: InheritanceHierarchyNode) {
    if (element.isBaseLabel) {
      ti.description = undefined;
    }
  }

  public async onGetChildren(
    element: InheritanceHierarchyNode
    ): Promise<InheritanceHierarchyNode[]> {
    const result = await this.languageClient.sendRequest<InheritanceHierarchyNode>(
      '$ccls/inheritance', {
        derived: element.wantsDerived,
        hierarchy: true,
        id: element.id,
        kind: element.kind,
        levels: 1,
        qualified: false,
    });
    element.children = result.children;
    result.children.map((c) => InheritanceHierarchySetWantsDerived(c, element.wantsDerived));
    return result.children;
  }

  protected async onReveal(uri: Uri, position: Position): Promise<InheritanceHierarchyNode> {
    const entry = await this.languageClient.sendRequest<InheritanceHierarchyNode>('$ccls/inheritance', {
      derived: true,
      hierarchy: true,
      levels: 1,
      position,
      qualified: false,
      textDocument: {
        uri: uri.toString(true),
      },
    });
    InheritanceHierarchySetWantsDerived(entry, true);

    const parentEntry = await this.languageClient.sendRequest<InheritanceHierarchyNode>(
      '$ccls/inheritance',
      {
        derived: false,
        hierarchy: true,
        id: entry.id,
        kind: entry.kind,
        levels: 1,
        qualified: false,
      }
    );
    if (parentEntry.numChildren > 0) {
      const parentWrapper: InheritanceHierarchyNode = {
        children: parentEntry.children,
        id: undefined,
        isBaseLabel: true,
        kind: -1,
        location: parentEntry.location,
        name: '[[Base]]',
        numChildren: parentEntry.children.length,
        wantsDerived: false,
      };
      InheritanceHierarchySetWantsDerived(
          parentWrapper, false);
      entry.children.unshift(parentWrapper);
      entry.numChildren += 1;
    }

    return entry;
  }
}
