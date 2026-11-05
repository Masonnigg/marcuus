#!/bin/zsh
# Links this folder into Premiere's extensions. Restart Premiere afterwards, then Window › Extensions › RYACHA.
set -e
ROOT="${0:A:h:h}"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.reda.marcuus.pubs"
mkdir -p "${DEST:h}"
if [[ -e "$DEST" && ! -L "$DEST" ]]; then
  echo "Refusing to replace a real folder at $DEST" >&2
  exit 1
fi
ln -sfn "$ROOT" "$DEST"
echo "Linked $DEST"
