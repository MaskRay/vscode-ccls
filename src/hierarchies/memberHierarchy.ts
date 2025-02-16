import { commands, Position, TreeItem, Uri } from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';
import { IHierarchyNode } from '../types';
import { Hierarchy } from './hierarchy';

enum MemberKind {
  Func = 3,
  Var = 4,
}

interface MemberHierarchyNode extends IHierarchyNode {
  fieldName: string;
  children: MemberHierarchyNode[];
}

export class MemberHierarchyProvider extends Hierarchy<MemberHierarchyNode> {
  protected contextValue: string = 'extension.ccls.memberHierarchyVisible';

  constructor(
    languageClient: LanguageClient
  ) {
    super(languageClient, 'ccls.memberHierarchy', 'ccls.closeMemberHierarchy');
  }

  public onTreeItem(ti: TreeItem, element: MemberHierarchyNode) {
    const parts: string[]  = element.fieldName.trim().split(' ');
    const off: number = parseInt(parts[0], 10);
    let fieldName: string = '';
    if (isNaN(off) || (parts.length < 3)) {
      fieldName = parts[1];
    } else {
      fieldName = parts[2];
      ti.tooltip = `Offset: ${off} bytes`;
    }

    if (fieldName !== undefined) {
      ti.label = fieldName;
      ti.description = `(${element.name}) ` + ti.description;
    }
  }

  protected async onGetChildren(element: MemberHierarchyNode): Promise<MemberHierarchyNode[]> {
    const result = await this.languageClient.sendRequest<MemberHierarchyNode>('$ccls/member', {
      hierarchy: true,
      id: element.id,
      kind: MemberKind.Var,
      levels: 1,
      qualified: false,
    });
    element.children = result.children;
    return result.children;
  }

  protected async onReveal(uri: Uri, position: Position): Promise<MemberHierarchyNode> {
    return this.languageClient.sendRequest<MemberHierarchyNode>(
      '$ccls/member',
      {
        hierarchy: true,
        kind: MemberKind.Var,
        levels: 2,
        position,
        qualified: false,
        textDocument: {
          uri: uri.toString(true),
        },
      }
    );
  }
}
