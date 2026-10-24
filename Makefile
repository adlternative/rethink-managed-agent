.PHONY: help up up-min down logs e2e test typecheck openapi-check cli-build sdk-build install install-dev uninstall diagram demo

help:
	@echo "make up          start the full stack (postgres/redis/minio/api/runner)"
	@echo "make up-min      minimal stack: Postgres only (no redis/minio) via docker-compose.pg.yml"
	@echo "make down        stop the stack"
	@echo "make logs        tail api + runner logs"
	@echo "make e2e         run scripts/e2e.sh against the running stack"
	@echo "make test        typecheck + openapi-check + vitest (server) and typecheck (cli + sdk)"
	@echo "make openapi-check  fail if openapi/v1.yaml drifts from openapi/route-inventory.ts"
	@echo "make sdk-build   compile packages/sdk (pma-sdk)"
	@echo "make install     build pma-cli and install 'pma' into ~/.local/bin (a copy: rerun after changes)"
	@echo "make install-dev install 'pma' as a live wrapper over this working copy (no rebuild after edits)"
	@echo "make uninstall   remove ~/.local/bin/pma"
	@echo "make diagram     render docs/architecture.html from the archify spec"
	@echo "make demo         run the architecture demos (no stack needed; docker optional)"

up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f --tail 100 api runner

e2e:
	bash scripts/e2e.sh

typecheck:
	npx tsc --noEmit -p tsconfig.json
	cd pma-cli && npx tsc --noEmit -p tsconfig.json
	npx tsc --noEmit -p packages/sdk/tsconfig.json

openapi-check:
	npx tsx scripts/openapi-check.ts

sdk-build:
	cd packages/sdk && npm install --include=dev && npm run build

test: typecheck openapi-check
	npx vitest run

cli-build:
	cd pma-cli && npm install --include=dev && node esbuild.config.js

# Same layout as qca-cli: the bundle plus a tiny wrapper in ~/.local/bin.
install: cli-build
	@mkdir -p ~/.local/bin
	@cp pma-cli/bundle/pma.js ~/.local/bin/pma.js
	@printf '{"name":"local-bin","private":true,"type":"module"}\n' > ~/.local/bin/package.json
	@printf '#!/bin/bash\nexec node ~/.local/bin/pma.js "$$@"\n' > ~/.local/bin/pma
	@chmod +x ~/.local/bin/pma
	@echo "✓ installed ~/.local/bin/pma  (run: pma login --host http://localhost:8080)"

# Development install: the wrapper runs this working copy's sources through tsx, so an edit is live on
# the next `pma` with no rebuild and no reinstall. Slower to start than the bundle; use `make install`
# for the real thing.
install-dev:
	@mkdir -p ~/.local/bin
	@rm -f ~/.local/bin/pma.js
	@printf '#!/bin/bash\nexec npx --yes tsx %s/pma-cli/src/index.ts "$$@"\n' "$(CURDIR)" > ~/.local/bin/pma
	@chmod +x ~/.local/bin/pma
	@echo "✓ installed ~/.local/bin/pma -> $(CURDIR)/pma-cli/src (live; no rebuild needed)"

uninstall:
	@rm -f ~/.local/bin/pma ~/.local/bin/pma.js
	@echo "✓ removed ~/.local/bin/pma"

diagram:
	bash scripts/diagram.sh

demo:
	bash demos/run.sh

up-min:
	docker compose -f docker-compose.yml -f docker-compose.pg.yml up --build -d postgres api runner
