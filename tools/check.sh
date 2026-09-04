#!/usr/bin/env bash
#
# Everything CI runs. One command, so the same checks pass locally.

set -uo pipefail

failed=0

step()
{
    printf '\n== %s\n' "$1"
    shift

    if ! "$@"
    then
        failed=1
    fi
}

step "types" npx tsc --noEmit
step "test" npx vitest run
step "docs" node tools/docs.mjs
step "boundaries" node tools/boundaries.mjs

if [ "$failed" -ne 0 ]
then
    printf '\nFAILED\n'
    exit 1
fi

printf '\nall checks pass\n'
