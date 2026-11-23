# security-ci

Centralny pipeline bezpieczeństwa CI/CD dla repozytoriów **DalmaPL** z aplikacjami Cloudflare Workers,
zbudowany na GitHub Reusable Workflows. Repozytoria docelowe mają tylko kilkulinijkowy plik wywołujący;
logika, wersje narzędzi i reguły żyją tutaj.

```
repo-z-workerem/.github/workflows/security.yml ──uses──▶ DalmaPL/security-ci/.github/workflows/cf-workers-security.yml@main
                                                          ├─ secrets-scan  Gitleaks, pełna historia  ──▶ SARIF → Security tab
                                                          ├─ sast          Semgrep                  ──▶ SARIF → Security tab
                                                          ├─ sca           npm/pnpm/yarn/bun audit + SBOM (artefakt)
                                                          └─ cf-hardening  wrangler.toml/json(c), .dev.vars
Ruleset organizacji ──required──▶ DalmaPL/security-ci/.github/workflows/org-required-security.yml (ten sam pipeline)
```

| Plik | Rola |
|---|---|
| [`.github/workflows/cf-workers-security.yml`](.github/workflows/cf-workers-security.yml) | Reusable workflow (`workflow_call`) – cały pipeline |
| [`.github/workflows/org-required-security.yml`](.github/workflows/org-required-security.yml) | Wrapper na `pull_request`/`merge_group` do wymuszenia rulesetem |
| [`.github/workflows/self-test.yml`](.github/workflows/self-test.yml) | Testy pipeline'u na fixture'ach z `fixtures/workers/` |
| [`templates/security-caller.yml`](templates/security-caller.yml) | Szablon do wklejenia w repo docelowym |

## Co sprawdza pipeline

| Job | Narzędzie | Failuje gdy | Uprawnienia |
|---|---|---|---|
| `secrets-scan` | Gitleaks 8.30.1 (binarka weryfikowana sha256), **cała historia** (`fetch-depth: 0`) | jakikolwiek wyciek | `contents: read`, `security-events: write`, `actions: read` |
| `sast` | Semgrep 1.186.0: `p/default`, `p/typescript`, `p/owasp-top-ten`, `p/secrets` | finding ≥ `semgrep-fail-level` (domyślnie `error`) | jw. |
| `sca` | `npm audit` / `pnpm audit` / `yarn audit` / `yarn npm audit` / `bun audit` + SBOM CycloneDX (Syft) | podatność ≥ `audit-level` (domyślnie `high`), brak lockfile | `contents: read` |
| `cf-hardening` | skrypt Python (tomllib + parser JSONC) | sekret w `[vars]`/`[env.*.vars]`, commitowany `.dev.vars*`/`.env*` | `contents: read` |

Zasady: top-level `permissions: contents: read`, każdy job dostaje minimum; `persist-credentials: false`
w każdym checkoutcie; akcje przypięte do pełnego SHA (aktualizuje je Dependabot w tym repo);
audyt zależności działa na lockfile **bez `install`**, więc skrypty `postinstall` nigdy nie są uruchamiane;
workflow nie potrzebuje żadnych sekretów (nie używaj `secrets: inherit`).

`cf-hardening` uznaje zmienną za sekret, gdy jej **wartość** pasuje do znanego formatu (klucz prywatny PEM,
`user:pass@` w URL, JWT, klucze AWS/GitHub/Stripe/Slack/Google/OpenAI/SendGrid) albo **nazwa** wygląda na sekret
(`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*API_KEY*`, `*_KEY`, `DATABASE_URL`, …) i wartość nie jest placeholderem.
Wartości o wysokiej entropii i brak `compatibility_date` dają ostrzeżenie. Sekrety Workers trzymaj w
`wrangler secret put` / Secrets Store, a lokalnie w `.dev.vars` dodanym do `.gitignore`.

### Parametry (`with:`)

| Input | Domyślnie | Opis |
|---|---|---|
| `node-version` | `24` | Node.js dla audytu |
| `package-manager` | `auto` | `auto` (wykrycie po lockfile) / `npm` / `pnpm` / `yarn` / `bun` |
| `working-directory` | `.` | katalog z `package.json` i lockfile dla audytu zależności i SBOM (np. `frontend`, `server`); Gitleaks, Semgrep i `cf-hardening` zawsze skanują całe repo |
| `audit-level` | `high` | `low` / `moderate` / `high` / `critical` |
| `fail-on-audit` | `true` | `false` = podatności tylko jako ostrzeżenie |
| `semgrep-fail-level` | `error` | `error` / `warning` / `note` / `none` |
| `upload-sarif` | `true` | upload do Code Scanning; SARIF zawsze zostaje też jako artefakt |
| `artifact-suffix` | `""` | sufiks artefaktów/kategorii SARIF przy kilku wywołaniach w jednym runie |

## Wdrożenie w istniejącym repozytorium

1. Skopiuj [`templates/security-caller.yml`](templates/security-caller.yml) do `.github/workflows/security.yml`.
2. Upewnij się, że lockfile jest w repo, a `.dev.vars` / `.env` są w `.gitignore`.
3. Otwórz PR – pierwszy run pokaże zastane problemy. Typowe poprawki:
   - sekret w `[vars]` → `wrangler secret put NAZWA`, usuń z `wrangler.toml`, **zrotuj** wartość (jest w historii);
   - wyciek w historii → zrotuj sekret; jeśli to fałszywy alarm, dodaj fingerprint do `.gitleaksignore`;
   - finding Semgrep → popraw albo `// nosemgrep: <rule-id>` z uzasadnieniem; wykluczenia ścieżek w `.semgrepignore`;
   - fałszywy alarm `cf-hardening` → komentarz `security-ci: allow` na końcu linii w `wrangler.*`;
     cały katalog (np. fixture testowy) → pusty plik `.security-ci-ignore` w tym katalogu.
   Wszystkie wyjątki są plikami w repo, więc przechodzą przez code review.
4. Po merge'u do `main` alerty pojawią się w **Security → Code scanning** (push na `main` zasila alerty gałęzi domyślnej).

Hurtowe otwarcie PR-ów w wielu repo (Git Bash + `gh`; lista repo do uzupełnienia):

```bash
for repo in DalmaPL/worker-a DalmaPL/worker-b; do
  gh repo clone "$repo" "/tmp/$repo" -- --depth 1 && cd "/tmp/$repo" || continue
  git switch -c ci/security-workflow
  mkdir -p .github/workflows && cp ~/security-ci/templates/security-caller.yml .github/workflows/security.yml
  git add .github/workflows/security.yml && git commit -m "ci: add central security workflow"
  git push -u origin HEAD && gh pr create --fill
  cd - >/dev/null
done
```

## Wymuszenie dla całej organizacji (Rulesets → Required workflows)

Wymuszenie działa niezależnie od tego, czy repo ma własny `security.yml`:

1. **Actions w security-ci:** repo jest publiczne, więc jego workflowy może wywoływać każde repo DalmaPL.
   Gdyby kiedyś stało się prywatne: *security-ci → Settings → Actions → General → Access →
   "Accessible from repositories in the 'DalmaPL' organization"*.
2. **Org → Settings → Rules → Rulesets → New ruleset → New branch ruleset**
   - *Enforcement status*: najpierw **Evaluate** (tylko raportuje), potem **Active**;
   - *Target repositories*: wszystkie albo wg wzorca / custom property (np. `runtime = cloudflare-workers`);
   - *Target branches*: `Include default branch`;
   - *Rules*: **Require workflows to pass before merging** → *Add workflow* → repo `DalmaPL/security-ci`,
     plik `.github/workflows/org-required-security.yml`, ref `main` (lub tag/SHA).
3. Wrapper reaguje na `pull_request` i `merge_group`, więc działa także z merge queue.
   Workflow z samym `workflow_call` nie może być wymagany – stąd osobny plik wrappera.

**Ograniczenia planu.** DalmaPL jest na planie **GitHub Free**: rulesety organizacji obejmują tam tylko repozytoria
publiczne, a Code Scanning (upload SARIF) w repo prywatnych wymaga GitHub Code Security. W repo prywatnych:
skany i tak działają i blokują PR (przez branch protection / ruleset na poziomie repo, jeśli dostępny),
upload SARIF kończy się ostrzeżeniem (`continue-on-error`), a wyniki są w artefaktach `*-sarif`
– możesz ustawić `upload-sarif: false`. Pełne wymuszenie na repo prywatnych wymaga planu Team/Enterprise
(sprawdź aktualną macierz funkcji w dokumentacji GitHub).

**Required workflow vs. `security.yml` w repo.** Wymagany workflow uruchamia się tylko na PR/merge queue.
Plik z szablonu dodaje skan po pushu na `main` (alerty gałęzi domyślnej w Security tab) i cotygodniowy
skan nowych CVE. Zalecane: oba – ruleset gwarantuje bramkę, szablon daje widoczność.

## Wersjonowanie

`@main` jest wygodne, ale każda zmiana w `main` od razu trafia do wszystkich repo. Dla stabilności:
taguj wydania (`v1`, `v1.2.0`) i w repo docelowych używaj `@v1`, a w rulesecie wskaż tag lub SHA.
Zmiany w pipeline najpierw przechodzą [`self-test.yml`](.github/workflows/self-test.yml):

- `clean-worker` – pełny pipeline na `fixtures/workers/clean` musi przejść;
- `insecure-worker` – krok `cf-hardening` uruchomiony na `fixtures/workers/insecure` musi wykryć wszystkie zaszyte
  problemy (fałszywe wartości; fixture jest wykluczony w `.gitleaks.toml`, `.semgrepignore` i `.security-ci-ignore`,
  więc `org-required-security.yml` przechodzi także na samym security-ci).
