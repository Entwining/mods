# Todo

- preallow: generate the credential rules from [Betterleaks](https://github.com/betterleaks/betterleaks) instead of gitleaks, which now takes only security fixes, once Betterleaks 2 is released. Most of its rules filter a match with an Expr expression and some score it by tokens (`tokenRatio`), so `scripts/gitleaks.ts` has to turn those into JavaScript or leave such rules out, and the keyword budget test still has to pass.
