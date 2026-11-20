#!/usr/bin/env bash
set -euo pipefail

if gh release view "$TAG" > /dev/null 2>&1; then
  echo "Release $TAG already exists."
  exit 0
fi

shopt -s nullglob
appimages=(release-assets/*.AppImage)
debs=(release-assets/*.deb)
installers=(release-assets/*.exe)
disk_images=(release-assets/*.dmg)
if (( ${#appimages[@]} != 1 || ${#debs[@]} != 1 || ${#installers[@]} != 1 || ${#disk_images[@]} != 1 )); then
  echo "Expected one AppImage, one DEB, one EXE, and one DMG." >&2
  exit 1
fi
gh release create "$TAG" --target "$GITHUB_SHA" --generate-notes \
  "${appimages[@]}" "${debs[@]}" "${installers[@]}" "${disk_images[@]}"
