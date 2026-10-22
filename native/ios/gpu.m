// <gpu/ui> on iOS: a UIView backed by CAMetalLayer for NativeView("gpu").
#import <QuartzCore/CAMetalLayer.h>
#import "ui_native.h"

@interface EskiuGpuView : UIView
@property(nonatomic, copy) UiViewEmit emit;
@property(nonatomic, assign) int pixelWidth;
@property(nonatomic, assign) int pixelHeight;
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
    } else if (liveView == self) {
        liveView = nil;
    }
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
        view.emit = emit;
        return view;
    }, ^(UIView *view, NSString *name, NSString *value) {
        (void)view;
        (void)name;
        (void)value;
    });
}
