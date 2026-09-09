// SheepIt - a menu bar switch for the SheepIt gateway.
//
// Owns two child processes and keeps them in step:
//   * the gateway itself (server.py), so the phone has something to talk to
//   * `caffeinate -s`, because an asleep Mac cannot send a push notification,
//     which is what made "notify me when an agent finishes" unreliable
//
// It also brings up the two services the gateway is useless without: Herdr
// itself, since the gateway is only a proxy onto its socket, and Tailscale,
// since the phone reaches the gateway over the tailnet.
//
// One switch drives all of it, and the bar icon shows the state at a glance.
//
// Written in Objective-C rather than Swift on purpose: this machine's Command
// Line Tools ship a duplicate SwiftBridging modulemap that breaks every Swift
// AppKit build, and clang is unaffected.

#import <AppKit/AppKit.h>
#import <signal.h>
#import <sys/socket.h>
#import <sys/un.h>
#import <unistd.h>

@interface Controller : NSObject <NSApplicationDelegate, NSMenuDelegate>
@property(strong) NSStatusItem *statusItem;
@property(strong) NSTask *server;
@property(strong) NSTask *caffeinate;
@property(strong) NSTask *herdr;
@property(copy) NSString *port;
@property(copy) NSString *serverPath;
@property(copy) NSString *tailscalePath;
@property(copy) NSString *herdrPath;
@property(copy) NSString *socketPath;
@property(assign) BOOL tailscaleUp;
@property(assign) BOOL herdrUp;
@end

@implementation Controller

- (BOOL)isRunning {
    return self.server != nil && self.server.isRunning;
}

#pragma mark - Locating the gateway

/// Resolution order: an explicit default, the environment, then a walk up from
/// the bundle - which finds it when the app is built inside the repo.
- (NSString *)resolveServerPath {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *pref = [NSUserDefaults.standardUserDefaults stringForKey:@"serverPath"];
    if (pref.length && [fm isReadableFileAtPath:pref]) return pref;

    NSString *env = NSProcessInfo.processInfo.environment[@"SHEEPIT_SERVER"];
    if (env.length && [fm isReadableFileAtPath:env]) return env;

    NSURL *dir = [NSURL fileURLWithPath:NSBundle.mainBundle.bundlePath];
    for (int i = 0; i < 6; i++) {
        dir = dir.URLByDeletingLastPathComponent;
        NSString *candidate = [dir URLByAppendingPathComponent:@"gateway/server.py"].path;
        if ([fm isReadableFileAtPath:candidate]) return candidate;
    }
    for (NSString *guess in @[@"~/repos/sheepit/gateway/server.py",
                              @"~/repos/herdr-mobile/gateway/server.py"]) {
        NSString *fallback = guess.stringByExpandingTildeInPath;
        if ([fm isReadableFileAtPath:fallback]) return fallback;
    }
    return nil;
}

#pragma mark - Herdr

/// Mirrors the gateway: HERDR_SOCKET, else the current user's config dir.
- (NSString *)resolveSocketPath {
    NSString *env = NSProcessInfo.processInfo.environment[@"HERDR_SOCKET"];
    if (env.length) return env;
    return @"~/.config/herdr/herdr.sock".stringByExpandingTildeInPath;
}

/// A GUI app inherits launchd's minimal PATH, not the login shell's, so the
/// binary has to be looked for where the installers actually put it.
- (NSString *)resolveHerdrPath {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *pref = [NSUserDefaults.standardUserDefaults stringForKey:@"herdrPath"];
    if (pref.length && [fm isExecutableFileAtPath:pref]) return pref;

    NSString *env = NSProcessInfo.processInfo.environment[@"HERDR_BIN"];
    if (env.length && [fm isExecutableFileAtPath:env]) return env;

    NSArray *candidates = @[
        @"/opt/homebrew/bin/herdr",
        @"/usr/local/bin/herdr",
        @"/run/current-system/sw/bin/herdr",   // nix-darwin
        @"~/.local/bin/herdr".stringByExpandingTildeInPath,
        @"~/.herdr/bin/herdr".stringByExpandingTildeInPath,
    ];
    for (NSString *path in candidates) {
        if ([fm isExecutableFileAtPath:path]) return path;
    }
    return nil;
}

/// Connect rather than stat: a crashed server leaves the socket file behind,
/// and `herdr status` would cost a process spawn on every menu open.
- (BOOL)checkHerdr {
    if (!self.socketPath) return NO;
    struct sockaddr_un addr = {0};
    addr.sun_family = AF_UNIX;
    const char *path = self.socketPath.fileSystemRepresentation;
    if (!path || strlen(path) >= sizeof(addr.sun_path)) return NO;
    strlcpy(addr.sun_path, path, sizeof(addr.sun_path));

    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return NO;
    BOOL ok = connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0;
    close(fd);
    return ok;
}

/// Off the main thread: the socket does not appear the instant the process does.
- (void)startHerdr {
    if (!self.herdrPath) return;
    if ([self checkHerdr]) { self.herdrUp = YES; [self render]; return; }

    // Detached from this app on purpose. The headless server holds every pane
    // and agent the user has open, so it outlives the switch being turned off
    // - stopping it is `herdr server stop`, never a side effect of quitting.
    //
    // setsid() first, via a python3 that immediately execs herdr: a plain child
    // stays in this app's process group, and launchd kills the whole group when
    // the LaunchAgent is booted out, which would take every open pane with it.
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/python3"];
    task.arguments = @[ @"-c", @"import os,sys; os.setsid(); os.execv(sys.argv[1], sys.argv[1:])",
                        self.herdrPath, @"server" ];
    task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    if (![task launchAndReturnError:nil]) return;
    self.herdr = task;

    __weak typeof(self) weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        BOOL up = NO;
        for (int i = 0; i < 50 && !up; i++) {   // up to 5s
            usleep(100000);
            up = [weakSelf checkHerdr];
        }
        dispatch_async(dispatch_get_main_queue(), ^{
            weakSelf.herdrUp = up;
            [weakSelf render];
        });
    });
}

#pragma mark - Tailscale

/// The CLI lives in /usr/local/bin for the standalone build and inside the
/// bundle for the App Store one.
- (NSString *)resolveTailscalePath {
    NSArray *candidates = @[
        @"/usr/local/bin/tailscale",
        @"/opt/homebrew/bin/tailscale",
        @"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ];
    for (NSString *path in candidates) {
        if ([NSFileManager.defaultManager isExecutableFileAtPath:path]) return path;
    }
    return nil;
}

/// `tailscale status` exits non-zero when the tailnet is not connected.
- (BOOL)checkTailscale {
    if (!self.tailscalePath) return NO;
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:self.tailscalePath];
    task.arguments = @[ @"status" ];
    task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    if (![task launchAndReturnError:nil]) return NO;
    [task waitUntilExit];
    return task.terminationStatus == 0;
}

/// Off the main thread: `tailscale up` can block while it reconnects.
- (void)startTailscale {
    if (!self.tailscalePath) return;
    __weak typeof(self) weakSelf = self;
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf || [strongSelf checkTailscale]) {
            dispatch_async(dispatch_get_main_queue(), ^{
                weakSelf.tailscaleUp = YES;
                [weakSelf render];
            });
            return;
        }
        NSTask *task = [NSTask new];
        task.executableURL = [NSURL fileURLWithPath:strongSelf.tailscalePath];
        task.arguments = @[ @"up" ];
        task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
        task.standardError = NSFileHandle.fileHandleWithNullDevice;
        if ([task launchAndReturnError:nil]) [task waitUntilExit];
        BOOL up = [strongSelf checkTailscale];
        dispatch_async(dispatch_get_main_queue(), ^{
            weakSelf.tailscaleUp = up;
            [weakSelf render];
        });
    });
}

#pragma mark - Lifecycle

- (void)applicationDidFinishLaunching:(NSNotification *)note {
    NSString *envPort = NSProcessInfo.processInfo.environment[@"SHEEPIT_PORT"];
    self.port = envPort.length ? envPort : @"3009";
    self.serverPath = [self resolveServerPath];
    self.tailscalePath = [self resolveTailscalePath];
    self.herdrPath = [self resolveHerdrPath];
    self.socketPath = [self resolveSocketPath];

    self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSVariableStatusItemLength];
    [self render];

    // Something else may already hold the port: our own orphaned gateway from
    // a previous run, which we can reclaim, or a launchd copy, which we cannot.
    pid_t holder = [self portHolder];
    if (holder > 0 && [self isOurGateway:holder]) {
        kill(holder, SIGTERM);
        usleep(400000);
    }
    if ([self portHolder] > 0) {
        [self warnPortBusy];
    } else {
        [self start];
    }
}

- (void)applicationWillTerminate:(NSNotification *)note {
    [self stop];
}

#pragma mark - Processes

- (void)start {
    if (!self.serverPath) { [self render]; return; }

    // The gateway is only a proxy onto Herdr's socket, so there has to be a
    // Herdr server on the other end for the phone to show anything at all.
    [self startHerdr];

    // System python3 is in the macOS firewall's allowlist; a Homebrew one is
    // not, and incoming tailnet connections to it are silently dropped.
    NSTask *py = [NSTask new];
    py.executableURL = [NSURL fileURLWithPath:@"/usr/bin/python3"];
    py.arguments = @[ self.serverPath ];
    NSMutableDictionary *env = [NSProcessInfo.processInfo.environment mutableCopy];
    if (!env[@"HOST"]) env[@"HOST"] = @"127.0.0.1";
    env[@"PORT"] = self.port;
    py.environment = env;
    py.currentDirectoryURL =
        [NSURL fileURLWithPath:self.serverPath].URLByDeletingLastPathComponent;
    __weak typeof(self) weakSelf = self;
    py.terminationHandler = ^(NSTask *t) {
        dispatch_async(dispatch_get_main_queue(), ^{ [weakSelf render]; });
    };
    [py launchAndReturnError:nil];
    self.server = py;

    // -s prevents system sleep but lets the display sleep, so the screen still
    // dims and locks normally. -w ties it to our own pid, so even a crash or
    // SIGKILL releases the assertion instead of holding the Mac awake forever.
    NSTask *caf = [NSTask new];
    caf.executableURL = [NSURL fileURLWithPath:@"/usr/bin/caffeinate"];
    caf.arguments = @[ @"-s", @"-w",
                       [NSString stringWithFormat:@"%d", NSProcessInfo.processInfo.processIdentifier] ];
    [caf launchAndReturnError:nil];
    self.caffeinate = caf;

    // The phone reaches the gateway over the tailnet, so bring it up too.
    [self startTailscale];

    [self render];
}

- (void)stop {
    if (self.server.isRunning) [self.server terminate];
    if (self.caffeinate.isRunning) [self.caffeinate terminate];
    self.server = nil;
    self.caffeinate = nil;
    [self render];
}

- (void)toggle:(id)sender {
    if (self.isRunning) [self stop]; else [self start];
}

#pragma mark - Menu

/* The same sheep the phone draws, as a menu bar template image: one flat
   silhouette that AppKit tints for the light or dark bar, so it cannot carry
   colour and says "running" with a slash instead. Drawn rather than shipped as
   an asset - the whole app is one .m file, and a bundled image would need a
   resource to keep in step with web/icon.svg. */
- (NSImage *)sheepImageRunning:(BOOL)running {
    const CGFloat height = 16.0;          // the usual size of menu bar artwork
    const CGFloat scale = height / 34.0;  // the sheep is drawn in a 44x34 box
    NSSize size = NSMakeSize(ceil(44.0 * scale), height);

    NSImage *image = [NSImage imageWithSize:size flipped:NO drawingHandler:^BOOL(NSRect rect) {
        NSAffineTransform *flip = [NSAffineTransform transform];
        [flip translateXBy:0 yBy:size.height];   // SVG's y grows downward,
        [flip scaleXBy:scale yBy:-scale];        // AppKit's grows up
        [flip concat];

        NSBezierPath *(^oval)(CGFloat, CGFloat, CGFloat, CGFloat) =
            ^NSBezierPath *(CGFloat cx, CGFloat cy, CGFloat rx, CGFloat ry) {
                return [NSBezierPath bezierPathWithOvalInRect:
                            NSMakeRect(cx - rx, cy - ry, rx * 2, ry * 2)];
            };

        // Head up: at this size the raised head is what makes it a sheep and
        // not a cloud.
        NSBezierPath *face = oval(36.4, 12.6, 5.4, 4.6);
        NSBezierPath *ear = oval(0, 0, 3, 1.8);
        NSAffineTransform *place = [NSAffineTransform transform];
        [place translateXBy:32.4 yBy:9];
        [place rotateByDegrees:-38];
        [ear transformUsingAffineTransform:place];

        NSBezierPath *sheep = [NSBezierPath bezierPath];
        sheep.windingRule = NSWindingRuleNonZero;   // lobes union, not cancel
        [sheep appendBezierPathWithRoundedRect:NSMakeRect(11, 21, 5, 12) xRadius:2.5 yRadius:2.5];
        [sheep appendBezierPathWithRoundedRect:NSMakeRect(23, 21, 5, 12) xRadius:2.5 yRadius:2.5];
        [sheep appendBezierPath:oval(11.5, 16, 7.5, 7.5)];
        [sheep appendBezierPath:oval(18, 11, 8, 8)];
        [sheep appendBezierPath:oval(25.5, 11.5, 7.5, 7.5)];
        [sheep appendBezierPath:oval(31, 16, 7, 7)];
        [sheep appendBezierPathWithRoundedRect:NSMakeRect(5, 13, 27, 13) xRadius:6.5 yRadius:6.5];
        [sheep appendBezierPath:ear];
        [sheep appendBezierPath:face];

        [NSColor.blackColor set];
        [sheep fill];

        /* A template image is a single alpha channel, so the head can only be
           told from the fleece by cutting the gap out of it. */
        NSGraphicsContext.currentContext.compositingOperation = NSCompositingOperationDestinationOut;
        face.lineWidth = 1.3;
        [face stroke];
        ear.lineWidth = 1.0;
        [ear stroke];
        [oval(38.2, 11.4, 1.2, 1.2) fill];

        if (!running) {
            // Stopped: a slash, carved with a clear margin so it stays legible
            // against the body underneath it.
            NSBezierPath *slash = [NSBezierPath bezierPath];
            [slash moveToPoint:NSMakePoint(6, 31)];
            [slash lineToPoint:NSMakePoint(38, 3)];
            slash.lineCapStyle = NSLineCapStyleRound;
            slash.lineWidth = 7.0;
            [slash stroke];                              // still erasing

            NSGraphicsContext.currentContext.compositingOperation = NSCompositingOperationSourceOver;
            slash.lineWidth = 3.0;
            [NSColor.blackColor set];
            [slash stroke];
        }
        return YES;
    }];

    image.template = YES;
    image.accessibilityDescription = running ? @"Sheep It gateway running"
                                             : @"Sheep It gateway stopped";
    return image;
}

- (void)render {
    BOOL on = self.isRunning;

    NSImage *image = [self sheepImageRunning:on];
    if (image) {
        self.statusItem.button.image = image;
    } else {
        self.statusItem.button.title = on ? @"H" : @"h";
    }
    self.statusItem.button.appearsDisabled = !on;

    NSMenu *menu = [NSMenu new];
    [menu addItem:[self header:on ? [NSString stringWithFormat:@"Gateway running on :%@", self.port]
                                  : @"Gateway stopped"]];
    [menu addItem:[self header:on ? @"Keeping the Mac awake"
                                  : @"Mac may sleep - no notifications"]];
    if (self.herdrPath || self.herdrUp) {
        [menu addItem:[self header:self.herdrUp ? @"Herdr server running"
                                                : @"Herdr server not running"]];
    } else {
        [menu addItem:[self header:@"herdr not found"]];
    }
    if (self.tailscalePath) {
        [menu addItem:[self header:self.tailscaleUp ? @"Tailscale connected"
                                                    : @"Tailscale disconnected"]];
    } else {
        [menu addItem:[self header:@"Tailscale not installed"]];
    }
    if (!self.serverPath) [menu addItem:[self header:@"server.py not found"]];
    [menu addItem:NSMenuItem.separatorItem];

    NSMenuItem *action = [[NSMenuItem alloc] initWithTitle:(on ? @"Turn Off" : @"Turn On")
                                                    action:@selector(toggle:)
                                             keyEquivalent:@"t"];
    action.target = self;
    [menu addItem:action];

    [menu addItem:NSMenuItem.separatorItem];
    [menu addItem:[[NSMenuItem alloc] initWithTitle:@"Quit"
                                             action:@selector(terminate:)
                                      keyEquivalent:@"q"]];
    menu.delegate = self;
    self.statusItem.menu = menu;
}

/// Both can be stopped from outside this app - Tailscale from its own menu bar
/// item, Herdr with `herdr server stop` - so re-check on open rather than
/// trusting the values from launch time.
- (void)menuWillOpen:(NSMenu *)menu {
    BOOL tailscale = [self checkTailscale];
    BOOL herdr = [self checkHerdr];
    if (tailscale != self.tailscaleUp || herdr != self.herdrUp) {
        self.tailscaleUp = tailscale;
        self.herdrUp = herdr;
        [self render];
    }
}

- (NSMenuItem *)header:(NSString *)text {
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:text action:nil keyEquivalent:@""];
    item.enabled = NO;
    return item;
}

#pragma mark - Helpers

- (NSString *)runCapturing:(NSString *)tool arguments:(NSArray<NSString *> *)args {
    NSTask *task = [NSTask new];
    task.executableURL = [NSURL fileURLWithPath:tool];
    task.arguments = args;
    NSPipe *pipe = [NSPipe pipe];
    task.standardOutput = pipe;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    if (![task launchAndReturnError:nil]) return @"";
    NSData *out = [pipe.fileHandleForReading readDataToEndOfFile];
    [task waitUntilExit];
    return [[NSString alloc] initWithData:out encoding:NSUTF8StringEncoding] ?: @"";
}

/// pid listening on our port, or 0.
- (pid_t)portHolder {
    NSString *out = [self runCapturing:@"/usr/sbin/lsof"
                             arguments:@[ @"-nP", [NSString stringWithFormat:@"-iTCP:%@", self.port],
                                          @"-sTCP:LISTEN", @"-t" ]];
    NSString *trimmed =
        [out stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return (pid_t)trimmed.intValue;
}

/// Only ever reclaim a process that is running the same server.py we would.
- (BOOL)isOurGateway:(pid_t)pid {
    if (!self.serverPath) return NO;
    NSString *cmd = [self runCapturing:@"/bin/ps"
                             arguments:@[ @"-o", @"command=", @"-p",
                                          [NSString stringWithFormat:@"%d", pid] ]];
    return [cmd containsString:self.serverPath];
}

- (void)warnPortBusy {
    NSAlert *alert = [NSAlert new];
    alert.messageText = [NSString stringWithFormat:@"Port %@ is already in use", self.port];
    alert.informativeText =
        @"Another process is serving this port - most likely the launchd "
        @"agent. Stop it so this app can own the gateway:\n\n"
        @"launchctl bootout gui/$(id -u)/com.sheepit.gateway";
    alert.alertStyle = NSAlertStyleWarning;
    [alert runModal];
}

@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        Controller *controller = [Controller new];
        app.delegate = controller;
        // Menu bar only: no Dock icon, no app switcher entry.
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [app run];
    }
    return 0;
}
