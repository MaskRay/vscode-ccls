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
  readonly parentKind: SymbolKind|CclsSymbolKind;
  readonly kind: SymbolKind|CclsSymbolKind;
  readonly isTypeMember: boolean;
  readonly storage: StorageClass;
  readonly lsRanges: Range[];
}

export interface PublishSemanticHighlightArgs {
  readonly uri: string;
  readonly symbols: SemanticSymbol[];
}

export const semanticKinds: string[] = [
  'function',
  'variable',
  'type',

  'enum',
  'globalVariable',
  'macro',
  'memberFunction',
  'memberVariable',
  'namespace',
  'parameter',
  'staticMemberFunction',
  'staticVariable',
  'typeAlias',
]

// TODO: enable bold/italic decorators, might need change in vscode
export class SemanticContext implements Disposable {
  private semanticDecorations = new Map<string, TextEditorDecorationType[]>();
  private semanticEnabled = new Map<string, boolean>();
  private cachedDecorations = new Map<string, Map<TextEditorDecorationType, Array<Range>>>();
  private _dispose: Disposable[] = [];

  public constructor() {
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
    const config = workspace.getConfiguration('ccls');

    for (const kind of semanticKinds) {
      let face = config.get<string[]>(`highlight.${kind}.face`, []);
      let enabled = false;
      let colors = config.get<Array<undefined|string>>(`highlight.${kind}.colors`, []);
      let props: string[][] = [];
      while (face.length > 0) {
        let newFace = []
        for (const f of face) {
          if (f == 'enabled')
            enabled = true;
          else if (f.indexOf(':') >= 0) {
            enabled = true;
            props.push(f.split(':'));
          } else {
            if (colors.length === 0)
              colors = config.get<Array<undefined|string>>(`highlight.${f}.colors`, []);
            const face1 = config.get(`highlight.${f}.face`);
            if (face1 instanceof Array)
              for (const f1 of (face1 as string[]))
                newFace.push(f1);
          }
        }
        face = newFace;
      }
      this.semanticEnabled.set(kind, enabled);

      if (colors.length === 0)
        colors = [undefined];
      this.semanticDecorations.set(kind, colors.map((color) => {
        const opt: DecorationRenderOptions = {};
        opt.rangeBehavior = DecorationRangeBehavior.ClosedClosed;
        opt.color = color;
        for (const prop of props)
          (opt as any)[prop[0]] = prop[1].trim();
        return window.createTextEditorDecorationType(opt as DecorationRenderOptions);
      }));
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

    switch (symbol.kind) {
    // Functions
    case SymbolKind.Method:
    case SymbolKind.Constructor:
      return get('memberFunction');
    case SymbolKind.Function:
      return get('function');
    case CclsSymbolKind.StaticMethod:
      return get('staticMemberFunction');

    // Types
    case SymbolKind.Namespace:
      return get('namespace');
    case SymbolKind.Class:
    case SymbolKind.Struct:
    case SymbolKind.Enum:
    case SymbolKind.TypeParameter:
      return get('type');
    case CclsSymbolKind.TypeAlias:
      return get('typeAlias');

    // Variables
    case SymbolKind.Field:
      if (symbol.storage == StorageClass.Static)
        return get('staticVariable');
      return get('memberVariable');
    case SymbolKind.Variable:
      if (symbol.parentKind === SymbolKind.File ||
          symbol.parentKind === SymbolKind.Namespace)
        return get('globalVariable');
      return get('variable');
    case SymbolKind.EnumMember:
      return get('enum');
    case CclsSymbolKind.Parameter:
      return get('parameter');
    case CclsSymbolKind.Macro:
      return get('macro');
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
