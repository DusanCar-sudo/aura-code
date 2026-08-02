# Aura Standing Rules

## Project isolation
Every new project, script, website, or unrelated piece of work must 
live in its own folder under /mnt/bigdata/aura/projects/<name>/, 
never directly inside the aura-code repository itself. Before 
creating any new file or folder at the root of aura-code that isn't 
part of the CLI tool's own source (src/, dist/, tests/, config 
files), stop and ask whether it belongs in its own project folder 
instead. This is not a suggestion — violations should be flagged as 
bugs, not treated as style preferences.

## Surfaces
This repo publishes to three separate places: the website (`site/`,
served at aurawebsite-eta.vercel.app), the repo page (`README.md`),
and the npm package (`src/`, the `aura` binary). A change to one
does not change the others.

The website is `site/` and only `site/`. `vercel.json` sets
`outputDirectory: "site"`, so nothing outside that directory is ever
served. Editing `aura.html`, `her-rubyness-manifesto.html`, or any
other stray root-level HTML changes nothing anyone can see.

When the request says website, site or landing page, edit `site/`.
When it says repo or readme, edit `README.md`. Putting an image "in
the repo" means commit it to `assets/` and reference it from
`README.md` — it never means adding it to the website. Committing an
asset and displaying it are two separate steps; do only the one
asked. If you cannot tell which surface is meant, stop and ask.

The repo root holds many one-off handoff docs, PDFs and HTML files
that belong to no surface. Their presence is not evidence of what
ships. `vercel.json` and `package.json` are the only authorities.

## Branch and secrets
The default branch is `master`, not `main`. Never inline a token
into a shell command; use `gh` or read from `.env`.
