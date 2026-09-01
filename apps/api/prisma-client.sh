#!/bin/sh
# Places the generated Prisma client into the production dependency tree.
#
# `prisma generate` writes into the @prisma/client package inside the *build*
# stage's store, and the production install never runs it — so without this the
# image builds cleanly and then dies on boot with "@prisma/client did not
# initialize yet", a failure no amount of `docker build` will reveal.
#
# A shell script rather than an inline RUN because pnpm's directory names carry
# a hash of the resolved dependency set: the development and production
# installs resolve differently, so the destination is not known until the image
# is being built, and COPY cannot glob a destination.
#
# Two traps are guarded here, both of which otherwise surface at container
# start rather than at build time:
#
#   - `cp -R src dest` nests inside dest when dest already exists, silently
#     leaving the un-generated stub in place.
#   - The stub and the generated client share filenames, so asserting that
#     default.js exists proves nothing. Only the generated one is accompanied
#     by a query engine and a copy of the schema.
set -eu

staged="${1:?usage: prisma-client.sh <staged-client-dir>}"

dest="$(find /app/node_modules/.pnpm -maxdepth 1 -type d -name '@prisma+client@*' -print -quit)/node_modules"
if [ ! -d "$dest" ]; then
  echo 'no @prisma/client in the production install' >&2
  exit 1
fi

rm -rf "$dest/.prisma"
cp -R "$staged" "$dest/.prisma"
rm -rf "$staged"

if ! ls "$dest/.prisma/client" | grep -qE 'query.engine|schema.prisma'; then
  echo 'placed .prisma is the stub, not a generated client' >&2
  ls "$dest/.prisma/client" >&2
  exit 1
fi

echo "Prisma client placed in $dest/.prisma"
