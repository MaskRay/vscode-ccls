import {
    CodeLens,
    commands,
    DecorationOptions,
    DecorationRangeBehavior,
    DecorationRenderOptions,
    ExtensionContext,
    Position,
    QuickPickItem,
    Range,
    TextDocument,
    TextEditor,
    TextEditorDecorationType,
    ThemeColor,
    Uri,
    window,
    workspace,
} from "vscode";
import {
    CancellationToken,
    LanguageClient,
    LanguageClientOptions,
    ProvideCodeLensesSignature,
    RevealOutputChannelOn,
    ServerOptions
} from "vscode-languageclient/lib/main";
import * as ls from "vscode-languageserver-types";

import { CallHierarchyNode, CallHierarchyProvider } from "./callHierarchy";
import { CclsErrorHandler } from "./cclsErrorHandler";
import {
  InheritanceHierarchyNode,
  InheritanceHierarchyProvider,
  InheritanceHierarchySetWantsDerived
} from "./inheritanceHierarchy";
import { ClientConfig } from "./types";
import { unwrap } from "./utils";
import { jumpToUriAtPosition } from "./vscodeUtils";

function setContext(name: string, value: any): void {
  commands.executeCommand("setContext", name, value);
}

enum SymbolKind {
  // lsSymbolKind
  Unknown = 0,
  File,
  Module,
  Namespace,
  Package,

  Class = 5,
  Method,
  Property,
  Field,
  Constructor,

  Enum = 10,
  Interface,
  Function,
  Variable,
  Constant,

  String = 15,
  Number,
  Boolean,
  Array,
  Object,

  Key = 20,
  Null,
  EnumMember,
  Struct,
  Event,

  Operator = 25,
  TypeParameter,

  // ccls extensions
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

export async function activate(context: ExtensionContext) {
  // Inactive regions.
  {
    const config = workspace.getConfiguration('ccls');
    if (!config.get('misc.showInactiveRegions')) return;
    const decorationType = window.createTextEditorDecorationType({
      dark: {
        backgroundColor: config.get('theme.dark.skippedRange.backgroundColor'),
        color: config.get('theme.dark.skippedRange.textColor'),
      },
      isWholeLine: true,
      light: {
        backgroundColor: config.get('theme.light.skippedRange.backgroundColor'),
        color: config.get('theme.light.skippedRange.textColor'),
      },
      rangeBehavior: DecorationRangeBehavior.ClosedClosed
    });

    const skippedRanges = new Map<string, Range[]>();

    await languageClient.onReady();
    languageClient.onNotification("$ccls/publishSkippedRanges", (args) => {
      const uri = normalizeUri(args.uri);
      let ranges: Range[] = args.skippedRanges.map(p2c.asRange);
      ranges = ranges.map((range) => {
        if (range.isEmpty || range.isSingleLine) return range;
        return range.with({ end: range.end.translate(-1, 23333) });
      });
      skippedRanges.set(uri, ranges);
      window.visibleTextEditors
        .filter((editor) => editor.document.uri.toString() === uri)
        .forEach((editor) => editor.setDecorations(decorationType, ranges));
    });

    window.onDidChangeActiveTextEditor((editor?: TextEditor) => {
      if (!editor)
        return;
      const uri = editor.document.uri.toString();
      const range = skippedRanges.get(uri);
      if (range) {
        editor.setDecorations(decorationType, range);
      }
    });

    // This only got called during dispose, which perfectly matches our goal.
    workspace.onDidCloseTextDocument((document) => {
      skippedRanges.delete(document.uri.toString());
    });
  }

  // Inheritance hierarchy.
  {
    const inheritanceHierarchyProvider =
        new InheritanceHierarchyProvider(languageClient);
    window.registerTreeDataProvider(
        'ccls.inheritanceHierarchy', inheritanceHierarchyProvider);
    commands.registerTextEditorCommand(
        'ccls.inheritanceHierarchy', async (editor) => {
          setContext('extension.ccls.inheritanceHierarchyVisible', true);

          const position = editor.selection.active;
          const uri = editor.document.uri;
          const entry = await languageClient.sendRequest<InheritanceHierarchyNode>('$ccls/inheritance', {
            derived: true,
            hierarchy: true,
            levels: 1,
            position,
            qualified: false,
            textDocument: {
              uri: uri.toString(),
            },
          });
          InheritanceHierarchySetWantsDerived(entry, true);

          const parentEntry = await languageClient.sendRequest<InheritanceHierarchyNode>(
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
              kind: -1,
              location: undefined,
              name: '[[Base]]',
              numChildren: parentEntry.children.length,
              wantsDerived: false
            };
            InheritanceHierarchySetWantsDerived(
                parentWrapper, false);
            entry.children.unshift(parentWrapper);
            entry.numChildren += 1;
          }

          inheritanceHierarchyProvider.root = entry;
          inheritanceHierarchyProvider.onDidChangeEmitter.fire();
          commands.executeCommand("workbench.view.explorer");
        });
    commands.registerCommand('ccls.closeInheritanceHierarchy', () => {
      setContext('extension.ccls.inheritanceHierarchyVisible', false);
      inheritanceHierarchyProvider.root = undefined;
      inheritanceHierarchyProvider.onDidChangeEmitter.fire();
    });
  }

  // Call Hierarchy
  {
    const callHierarchyProvider = new CallHierarchyProvider(languageClient);
    window.registerTreeDataProvider('ccls.callHierarchy', callHierarchyProvider);
    commands.registerTextEditorCommand('ccls.callHierarchy', async (editor) => {
      setContext('extension.ccls.callHierarchyVisible', true);
      const position = editor.selection.active;
      const uri = editor.document.uri;
      const callNode = await languageClient.sendRequest<CallHierarchyNode>(
        '$ccls/call',
        {
          callType: 0x1 | 0x2,
          callee: false,
          hierarchy: true,
          levels: 2,
          position,
          qualified: false,
          textDocument: {
            uri: uri.toString(),
          },
        }
      );
      callHierarchyProvider.root = callNode;
      callHierarchyProvider.onDidChangeEmitter.fire();
      commands.executeCommand("workbench.view.explorer");
    });
    commands.registerCommand('ccls.closeCallHierarchy', (e) => {
      setContext('extension.ccls.callHierarchyVisible', false);
      callHierarchyProvider.root = undefined;
      callHierarchyProvider.onDidChangeEmitter.fire();
    });
  }

  // Common between tree views.
  {
    commands.registerCommand(
        'ccls.gotoForTreeView',
        async (node: InheritanceHierarchyNode|CallHierarchyNode) => {
          if (!node.location)
            return;

          const parsedUri = Uri.parse(node.location.uri);
          const parsedPosition = p2c.asPosition(node.location.range.start);

          return jumpToUriAtPosition(parsedUri, parsedPosition, true /*preserveFocus*/);
        });

    let lastGotoNodeId: any;
    let lastGotoClickTime: number;
    commands.registerCommand(
        'ccls.hackGotoForTreeView',
        (node: InheritanceHierarchyNode|CallHierarchyNode,
         hasChildren: boolean) => {
          if (!node.location)
            return;

          if (!hasChildren) {
            commands.executeCommand('ccls.gotoForTreeView', node);
            return;
          }

          if (lastGotoNodeId !== node.id) {
            lastGotoNodeId = node.id;
            lastGotoClickTime = Date.now();
            return;
          }

          const config = workspace.getConfiguration('ccls');
          const kDoubleClickTimeMs =
              config.get('treeViews.doubleClickTimeoutMs', 500);
          const elapsed = Date.now() - lastGotoClickTime;
          lastGotoClickTime = Date.now();
          if (elapsed < kDoubleClickTimeMs)
            commands.executeCommand('ccls.gotoForTreeView', node);
        });
  }

  // Semantic highlighting
  // TODO:
  //   - enable bold/italic decorators, might need change in vscode
  //   - only function call icon if the call is implicit
  {
    function makeSemanticDecorationType(
        color: string|null, underline: boolean, italic: boolean,
        bold: boolean): TextEditorDecorationType {
      const opts: any = {};
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

    function makeDecorations(type: string) {
      const config = workspace.getConfiguration('ccls');
      const colors = config.get(`highlighting.colors.${type}`, []);
      const u = config.get(`highlighting.underline.${type}`, false);
      const i = config.get(`highlighting.italic.${type}`, false);
      const b = config.get(`highlighting.bold.${type}`, false);
      return colors.map((c) => makeSemanticDecorationType(c, u, i, b));
    }
    const semanticDecorations = new Map<string, TextEditorDecorationType[]>();
    const semanticEnabled = new Map<string, boolean>();
    for (const type of
             ['types', 'freeStandingFunctions', 'memberFunctions',
              'freeStandingVariables', 'memberVariables', 'namespaces',
              'macros', 'enums', 'typeAliases', 'enumConstants',
              'staticMemberFunctions', 'parameters', 'templateParameters',
              'staticMemberVariables', 'globalVariables']) {
      semanticDecorations.set(type, makeDecorations(type));
      semanticEnabled.set(type, false);
    }

    function updateConfigValues() {
      // Fetch new config instance, since vscode will cache the previous one.
      const config = workspace.getConfiguration('ccls');
      for (const [name, value] of semanticEnabled) {
        semanticEnabled.set(
            name, config.get(`highlighting.enabled.${name}`, false));
      }
    }
    updateConfigValues();

    function tryFindDecoration(symbol: SemanticSymbol):
        TextEditorDecorationType|undefined {
      function get(name: string) {
        if (!semanticEnabled.get(name))
          return undefined;
        const decorations = unwrap(semanticDecorations.get(name), "semantic");
        return decorations[symbol.id % decorations.length];
      }

      if (symbol.kind === SymbolKind.Class || symbol.kind === SymbolKind.Struct) {
        return get('types');
      } else if (symbol.kind === SymbolKind.Enum) {
        return get('enums');
      } else if (symbol.kind === SymbolKind.TypeAlias) {
        return get('typeAliases');
      } else if (symbol.kind === SymbolKind.TypeParameter) {
        return get('templateParameters');
      } else if (symbol.kind === SymbolKind.Function) {
        return get('freeStandingFunctions');
      } else if (
          symbol.kind === SymbolKind.Method ||
          symbol.kind === SymbolKind.Constructor) {
        return get('memberFunctions');
      } else if (symbol.kind === SymbolKind.StaticMethod) {
        return get('staticMemberFunctions');
      } else if (symbol.kind === SymbolKind.Variable) {
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
      } else if (symbol.kind === SymbolKind.Parameter) {
        return get('parameters');
      } else if (symbol.kind === SymbolKind.EnumMember) {
        return get('enumConstants');
      } else if (symbol.kind === SymbolKind.Namespace) {
        return get('namespaces');
      } else if (symbol.kind === SymbolKind.Macro) {
        return get('macros');
      }
    }

    interface PublishSemanticHighlightArgs {
      readonly uri: string;
      readonly symbols: SemanticSymbol[];
    }

    const cachedDecorations = new Map<string, Map<TextEditorDecorationType, Array<Range>>>();

    function updateDecoration(editor: TextEditor) {
      const uri = editor.document.uri.toString();
      const cachedDecoration = cachedDecorations.get(uri);
      if (cachedDecoration) {
        // Clear decorations and set new ones. We might not use all of the
        // decorations so clear before setting.
        for (const [_, decorations] of semanticDecorations) {
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

    window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor) {
          updateDecoration(editor);
        }
      },
      null,
      context.subscriptions
    );

    await languageClient.onReady();
    languageClient.onNotification(
        '$ccls/publishSemanticHighlight',
        (args: PublishSemanticHighlightArgs) => {
          updateConfigValues();

          for (const visibleEditor of window.visibleTextEditors) {
            if (normalizeUri(args.uri) !== visibleEditor.document.uri.toString())
              continue;

            const decorations = new Map<TextEditorDecorationType, Array<Range>>();

            for (const symbol of args.symbols) {
              const type = tryFindDecoration(symbol);
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

            cachedDecorations.set(args.uri, decorations);
            updateDecoration(visibleEditor);
          }
        });
  }

  // Semantic navigation
  {
    function makeNavigateHandler(methodName: string) {
      return async (userParams: any) => {
        const editor = unwrap(window.activeTextEditor, "window.activeTextEditor");
        const position = editor.selection.active;
        const uri = editor.document.uri;
        const locations = await languageClient.sendRequest<Array<ls.Location>>(
          methodName,
          {
            position,
            textDocument: {
              uri: uri.toString(),
            },
            ...userParams
          }
        );
        if (locations.length === 1) {
          const location = p2c.asLocation(locations[0]);
          await jumpToUriAtPosition(
            location.uri, location.range.start,
            false /*preserveFocus*/);
        }
      };
    }
    commands.registerCommand('ccls.navigate', makeNavigateHandler('$ccls/navigate'));
  }
}
