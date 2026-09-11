.PHONY: help up up-min down logs e2e test typecheck cli-build install uninstall diagram demo

help:
	@echo "make up          start the full stack (postgres/redis/minio/api/runner)"
	@echo "make up-min      minimal stack: Postgres only (no redis/minio) via docker-compose.pg.yml"
	@echo "make down        stop the stack"
	@echo "make logs        tail api + runner logs"
	@echo "make e2e         run scripts/e2e.sh against the running stack"
	@echo "make test        typecheck + vitest (server) and typecheck (cli)"
	@echo "make install     build pma-cli and install 'pma' into ~/.local/bin"
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

test: typecheck
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

uninstall:
	@rm -f ~/.local/bin/pma ~/.local/bin/pma.js
	@echo "✓ removed ~/.local/bin/pma"

diagram:
	bash scripts/diagram.sh

demo:
	bash demos/run.sh

up-min:
	docker compose -f docker-compose.yml -f docker-compose.pg.yml up --build -d postgres api runner
