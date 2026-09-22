# Harbor Turath Arabic Books

Harbor eBook source plugin for the Turath.io Arabic book catalog.

## Repository layout

- `repo.json` — Harbor eBook repository manifest.
- `turath.plugin.js` — Harbor source plugin.

## Add to Harbor

Publish these files in any public GitHub repository. Then add the **repository URL** to Harbor's eBook source/repository manager.

Example repository layout:

```text
my-harbor-turath/
├── repo.json
├── turath.plugin.js
└── README.md
```

Do not add an `npm install` dependency: the plugin is self-contained.

## Data source

The plugin calls:

- `https://api.turath.io/search`
- `https://api.turath.io/book`
- `https://api.turath.io/page`

It returns Arabic book metadata, searchable books, section-based chapters, and Arabic page text.
