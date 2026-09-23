#!/bin/sh
# Copies the shared task-graph modules next to the accounts worker so wrangler bundles them. Run before `wrangler deploy`.
mkdir -p agent
for f in graph.js graph-store.js planner.js tools.js; do cp ../agent/$f agent/$f; done
cp ../public/rag.js agent/rag.js
