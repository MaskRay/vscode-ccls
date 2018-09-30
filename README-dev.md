# ccls

This is the Visual Studio Code extension for ccls, which originates from cquery.

The main ccls language server which powers this extension is found at
<https://github.com/MaskRay/ccls>.

# Building

## Dependencies

Make sure you have `npm` installed.

## Build

```bash
npm install
python build.py
```

Now, you can use vscode to install `out/ccls.vsix`.

# Deploying

To deploy a new release to the marketplace, simply run `publish.py` with a
clean working directory. By default a patch release is performed.

```bash
python publish.py [patch|minor|major]
```

# LICENSE

MIT
