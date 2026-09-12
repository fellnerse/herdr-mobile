# Builds a minimal arm64 .app bundle. No Xcode project, no dependencies.
APP     := SheepIt
OLDAPP  := HerdrMenuBar
BUNDLE  := build/$(APP).app
TARGET  := arm64-apple-macos13.0
AGENT   := com.sheepit.menubar
OLDAGENT:= com.herdr.menubar
ICON    := build/$(APP).icns
ICONSRC := ../web/icon.svg

.PHONY: all run install login unlogin clean

all: $(BUNDLE)

# The Finder icon is the phone's home screen sheep, wrapped in the rounded
# rectangle macOS expects and rasterised from the same SVG.
$(ICON): $(ICONSRC) make-icns.py
	@python3 make-icns.py $(ICON)

$(BUNDLE): main.m Info.plist $(ICON)
	@mkdir -p $(BUNDLE)/Contents/MacOS $(BUNDLE)/Contents/Resources
	clang -O2 -fobjc-arc -target $(TARGET) -framework AppKit \
	    -o $(BUNDLE)/Contents/MacOS/$(APP) main.m
	@cp Info.plist $(BUNDLE)/Contents/Info.plist
	@cp $(ICON) $(BUNDLE)/Contents/Resources/$(APP).icns
	@touch $(BUNDLE)
	@echo "built $(BUNDLE)"

run: $(BUNDLE)
	open $(BUNDLE)

# Copy to /Applications so it can be added to Login Items. The running copy is
# quit first: the menu bar icon lives in the binary, so an old instance left
# running keeps drawing the old one however many times the app is replaced.
install: $(BUNDLE)
	-killall $(APP) $(OLDAPP) 2>/dev/null
	-launchctl bootout gui/$$(id -u)/$(OLDAGENT) 2>/dev/null
	rm -rf /Applications/$(APP).app /Applications/$(OLDAPP).app
	rm -f ~/Library/LaunchAgents/$(OLDAGENT).plist
	cp -R $(BUNDLE) /Applications/
	@touch /Applications/$(APP).app
	@echo "installed to /Applications/$(APP).app"
	@echo "(if Finder still shows the old icon: killall Finder)"

# Start at login. A LaunchAgent rather than a Login Item because scripting
# System Events needs Automation permission that cannot be prompted for here.
login: install
	cp ../deploy/$(AGENT).plist ~/Library/LaunchAgents/
	-launchctl bootout gui/$$(id -u)/$(AGENT) 2>/dev/null
	launchctl bootstrap gui/$$(id -u) ~/Library/LaunchAgents/$(AGENT).plist
	@echo "will start at login"

unlogin:
	-launchctl bootout gui/$$(id -u)/$(AGENT)
	-launchctl bootout gui/$$(id -u)/$(OLDAGENT) 2>/dev/null
	rm -f ~/Library/LaunchAgents/$(AGENT).plist ~/Library/LaunchAgents/$(OLDAGENT).plist
	@echo "removed from login"

clean:
	rm -rf build
