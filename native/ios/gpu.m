// <gpu/ui> on iOS: a UIView backed by CAMetalLayer for NativeView("gpu"). Its touches go on
// the "gpu" channel as "touch TIME_MS COUNT (ID PHASE X Y)..." (<gpu/touch>).
#import <QuartzCore/CAMetalLayer.h>
#import "ui_native.h"

@interface EskiuGpuView : UIView
@property(nonatomic, copy) UiViewEmit emit;
@property(nonatomic, assign) int pixelWidth;
@property(nonatomic, assign) int pixelHeight;
// Each touch that is down (by address: UIKit keeps one UITouch per finger) to its id.
@property(nonatomic, strong) NSMutableDictionary<NSValue *, NSNumber *> *touchIds;
@end

static __weak EskiuGpuView *liveView;

@implementation EskiuGpuView
+ (Class)layerClass {
    return CAMetalLayer.class;
}

- (void)didMoveToWindow {
    [super didMoveToWindow];
    if (self.window) {
        liveView = self;
        [self updateDrawableSize];
    } else {
        [self.touchIds removeAllObjects];
        if (liveView == self) liveView = nil;
    }
}

// The id of a touch: the smallest one not in use when it goes down (as Android's pointer
// ids), -1 for a touch this view never saw go down.
- (int)idForTouch:(UITouch *)touch phase:(int)phase {
    NSValue *key = [NSValue valueWithNonretainedObject:touch];
    NSNumber *known = self.touchIds[key];
    if (phase != 0) return known ? known.intValue : -1;
    if (!self.touchIds) self.touchIds = [NSMutableDictionary dictionary];
    NSSet<NSNumber *> *used = [NSSet setWithArray:self.touchIds.allValues];
    int next = 0;
    while ([used containsObject:@(next)]) next++;
    self.touchIds[key] = @(next);
    return next;
}

// One payload per UIKit call: moves come coalesced to one per frame. Positions are pixels,
// as the drawable's size.
- (void)sendTouches:(NSSet<UITouch *> *)touches event:(UIEvent *)event phase:(int)phase {
    CGFloat scale = self.contentScaleFactor;
    NSMutableString *items = [NSMutableString string];
    int count = 0;
    NSTimeInterval time = event ? event.timestamp : NSProcessInfo.processInfo.systemUptime;
    for (UITouch *touch in touches) {
        int ident = [self idForTouch:touch phase:phase];
        if (ident < 0) continue;
        CGPoint p = [touch locationInView:self];
        [items appendFormat:@" %d %d %ld %ld", ident, phase, lround(p.x * scale), lround(p.y * scale)];
        count++;
        if (phase >= 2) [self.touchIds removeObjectForKey:[NSValue valueWithNonretainedObject:touch]];
    }
    if (count == 0) return;
    NSString *payload = [NSString stringWithFormat:@"touch %lld %d%@", (long long)llround(time * 1000.0), count, items];
    ui_native_emit("gpu", payload.UTF8String);
}

- (void)touchesBegan:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [self sendTouches:touches event:event phase:0];
}

- (void)touchesMoved:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [self sendTouches:touches event:event phase:1];
}

- (void)touchesEnded:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [self sendTouches:touches event:event phase:2];
}

- (void)touchesCancelled:(NSSet<UITouch *> *)touches withEvent:(UIEvent *)event {
    [self sendTouches:touches event:event phase:3];
}

- (void)layoutSubviews {
    [super layoutSubviews];
    [self updateDrawableSize];
}

- (void)updateDrawableSize {
    if (!self.window) return;
    CGFloat scale = self.window.screen ? self.window.screen.nativeScale : UIScreen.mainScreen.nativeScale;
    if (scale <= 0) scale = 1.0;
    self.contentScaleFactor = scale;
    CAMetalLayer *metal = (CAMetalLayer *)self.layer;
    metal.contentsScale = scale;
    int w = (int)llround(self.bounds.size.width * scale);
    int h = (int)llround(self.bounds.size.height * scale);
    if (w <= 0 || h <= 0) return;
    if (w == self.pixelWidth && h == self.pixelHeight) return;
    self.pixelWidth = w;
    self.pixelHeight = h;
    metal.drawableSize = CGSizeMake(w, h);
    liveView = self;
    NSString *sizePayload = [NSString stringWithFormat:@"%d %d", w, h];
    if (self.emit) {
        self.emit(@"resize", sizePayload);
    }
    NSString *chanPayload = [NSString stringWithFormat:@"resize %d %d", w, h];
    ui_native_emit("gpu", chanPayload.UTF8String);
}
@end

void *gpu_ui_native_handle(int *width, int *height) {
    EskiuGpuView *view = liveView;
    if (!view || view.pixelWidth <= 0 || view.pixelHeight <= 0) {
        if (width) *width = 0;
        if (height) *height = 0;
        return NULL;
    }
    if (width) *width = view.pixelWidth;
    if (height) *height = view.pixelHeight;
    return (__bridge void *)view.layer;
}

UI_NATIVE_SETUP(gpu) {
    ui_register_view(@"gpu", ^UIView *(UiViewEmit emit) {
        EskiuGpuView *view = [EskiuGpuView new];
        view.backgroundColor = UIColor.blackColor;
        view.opaque = YES;
        view.multipleTouchEnabled = YES;
        view.emit = emit;
        return view;
    }, ^(UIView *view, NSString *name, NSString *value) {
        (void)view;
        (void)name;
        (void)value;
    });
}
