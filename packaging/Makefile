# ─────────────────────────────────────────────────────────────────────────────
# Installer builds.
#
#   make -C packaging stage     stage the shared app tree
#   make -C packaging deb       Debian/Ubuntu package
#   make -C packaging rpm       Fedora/RHEL package (needs rpmbuild)
#   make -C packaging linux     both
#   make -C packaging windows   Windows .exe — native (stage on Windows first)
#   make -C packaging clean
#
# All targets package the same staged tree, so the artifacts stay identical
# across formats.
# ─────────────────────────────────────────────────────────────────────────────

REPO_ROOT := $(shell cd .. && pwd)
BUILD     := $(REPO_ROOT)/build
STAGE     := $(BUILD)/stage
DIST      := $(BUILD)/dist

.PHONY: all stage deb rpm linux windows clean help

help:
	@sed -n '4,10p' $(MAKEFILE_LIST) | sed 's/^# \?//'

stage:
	@./common/stage.sh

# The package builds read $(STAGE); stage first if it is not there yet.
$(STAGE)/app:
	@./common/stage.sh

deb: $(STAGE)/app
	@./linux/build-deb.sh

rpm: $(STAGE)/app
	@./linux/build-rpm.sh

linux: deb rpm

# Native Windows now, so this no longer depends on the .deb. The payload must
# be staged on Windows by windows/stage-windows.ps1 — build-exe.sh explains
# how if it is missing. CI does the whole thing on windows-latest; see
# .github/workflows/release-windows.yml.
windows:
	@./windows/build-exe.sh

clean:
	@rm -rf $(BUILD)
	@echo "removed $(BUILD)"
