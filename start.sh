#!/bin/bash
export PATH="$HOME/.local/share/fnm/node-versions/v24.14.1/installation/bin:$PATH"
cd "$(dirname "$0")"
npm run dev
