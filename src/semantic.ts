import {
  DecorationRangeBehavior,
  DecorationRenderOptions,
  Disposable,
  Range,
  TextEditor,
  TextEditorDecorationType,
  window,
  workspace,
} from "vscode";
import { SymbolKind } from "vscode-languageserver-types";
import { disposeAll, normalizeUri, unwrap } from "./utils";

enum CclsSymbolKind {
  // ls.SymbolKind ccls extensions
  TypeAlias = 252,
  Parameter = 253,
  StaticMethod = 254,
  Macro = 255
}

enum StorageClass {
  Invalid,
  None,
  Extern,
  Static,
  PrivateExtern,
  Auto,
  Register
}

interface SemanticSymbol {
  readonly id: number;
  readonly parentKind: SymbolKind;
  readonly kind: SymbolKind;
  readonly isTypeMember: boolean;
  readonly storage: StorageClass;
  readonly lsRanges: Range[];
}

export interface PublishSemanticHighlightArgs {
  readonly uri: string;
  readonly symbols: SemanticSymbol[];
}

function makeSemanticDecorationType(
  color: string|undefined, underline: boolean, italic: boolean,
  bold: boolean): TextEditorDecorationType {
  const opts: DecorationRenderOptions = {};
  opts.rangeBehavior = DecorationRangeBehavior.ClosedClosed;
  opts.color = color;
  if (underline === true)
    opts.textDecoration = 'underline';
  if (italic === true)
    opts.fontStyle = 'italic';
  if (bold === true)
    opts.fontWeight = 'bold';
  return window.createTextEditorDecorationType(
      opts as DecorationRenderOptions);
}

export const semanticTypes: {[name: string]: Array<SymbolKind|CclsSymbolKind>} = {
  enumConstants: [SymbolKind.EnumMember],
  enums: [SymbolKind.Enum],
  freeStandingFunctions: [SymbolKind.Function],
  freeStandingVariables: [],
  globalVariables: [],
  macros: [CclsSymbolKind.Macro],
  memberFunctions: [SymbolKind.Method, SymbolKind.Constructor],
  memberVariables: [SymbolKind.Field],
  namespaces: [SymbolKind.Namespace],
  parameters: [CclsSymbolKind.Parameter],
  staticMemberFunctions: [CclsSymbolKind.StaticMethod],
  staticMemberVariables: [],
  templateParameters: [SymbolKind.TypeParameter],
  typeAliases: [CclsSymbolKind.TypeAlias],
  types: [SymbolKind.Class, SymbolKind.Struct],
};

function makeDecorations(type: string) {
  const config = workspace.getConfiguration('ccls');
  let colors = config.get(`highlighting.colors.${type}`, [undefined]);
  if (colors.length === 0)
    colors = [undefined];
  const u = config.get(`highlighting.underline.${type}`, false);
  const i = config.get(`highlighting.italic.${type}`, false);
  const b = config.get(`highlighting.bold.${type}`, false);
  return colors.map((c) => makeSemanticDecorationType(c, u, i, b));
}

// TODO: enable bold/italic decorators, might need change in vscode
export class SemanticContext implements Disposable {
  private semanticDecorations = new Map<string, TextEditorDecorationType[]>();
  private semanticEnabled = new Map<string, boolean>();
  private cachedDecorations = new Map<string, Map<TextEditorDecorationType, Array<Range>>>();
  private _dispose: Disposable[] = [];

  public constructor() {
    for (const type of Object.keys(semanticTypes)) {
      this.semanticDecorations.set(type, makeDecorations(type));
      this.semanticEnabled.set(type, false);
    }

    this.updateConfigValues();

    window.onDidChangeActiveTextEditor(
      (editor?: TextEditor) => {
        if (editor) {
          this.updateDecoration(editor);
        }
      },
      undefined,
      this._dispose
    );
  }

  public dispose() {
    disposeAll(this._dispose);
  }

  public publishSemanticHighlight(args: PublishSemanticHighlightArgs) {
    this.updateConfigValues();

    const normUri = normalizeUri(args.uri);

    for (const visibleEditor of window.visibleTextEditors) {
      if (normUri !== visibleEditor.document.uri.toString(true))
        continue;

      const decorations = new Map<TextEditorDecorationType, Array<Range>>();

      for (const symbol of args.symbols) {
        const type = this.tryFindDecoration(symbol);
        if (!type)
          continue;
        const existing = decorations.get(type);
        if (existing) {
          for (const range of symbol.lsRanges) {
            existing.push(range);
          }
        } else {
          decorations.set(type, symbol.lsRanges);
        }
      }

      // TODO limit cache size
      this.cachedDecorations.set(normUri, decorations);
      this.updateDecoration(visibleEditor);
    }
  }

  private updateConfigValues() {
    // Fetch new config instance, since vscode will cache the previous one.
    const config = workspace.getConfiguration('ccls');
    for (const [name, _value] of this.semanticEnabled) {
      this.semanticEnabled.set(name, config.get(`highlighting.enabled.${name}`, false));
    }
  }

  private tryFindDecoration(
    symbol: SemanticSymbol
  ): TextEditorDecorationType|undefined {
    const get = (name: string) => {
      if (!this.semanticEnabled.get(name))
        return undefined;
      const decorations = unwrap(this.semanticDecorations.get(name), "semantic");
      return decorations[symbol.id % decorations.length];
    };

    if (symbol.kind === SymbolKind.Variable) {
      if (symbol.parentKind === SymbolKind.Function ||
          symbol.parentKind === SymbolKind.Method ||
          symbol.parentKind === SymbolKind.Constructor) {
        return get('freeStandingVariables');
      }
      return get('globalVariables');
    } else if (symbol.kind === SymbolKind.Field) {
      if (symbol.storage === StorageClass.Static) {
        return get('staticMemberVariables');
      }
      return get('memberVariables');
    } else {
      for (const name of Object.keys(semanticTypes)) {
        const kinds = semanticTypes[name];
        if (kinds.some((e) => e === symbol.kind)) {
          return get(name);
        }
      }
    }
  }

  private updateDecoration(editor: TextEditor) {
    const uri = editor.document.uri.toString(true);
    const cachedDecoration = this.cachedDecorations.get(uri);
    if (cachedDecoration) {
      // Clear decorations and set new ones. We might not use all of the
      // decorations so clear before setting.
      for (const [_, decorations] of this.semanticDecorations) {
        decorations.forEach((type) => {
          editor.setDecorations(type, []);
        });
      }
      // Set new decorations.
      cachedDecoration.forEach((ranges, type) => {
        editor.setDecorations(type, ranges);
      });
    }
  }
}
