# iOS and Android

Rendering into an [`eskiu-lang/ui`](https://github.com/eskiu-lang/ui) app with `<gpu/ui>`, and reading touches. The platform table is in the [README](../README.md#platforms).

## A game loop

A game holds its `Gpu` and `GpuSurface` while the surface lives and draws once per display
frame with eskiu-ui's `use_frame`, which runs while its first argument is true:

```eskiu
import <ui>;
import <gpu/ui>;
#if defined(__ANDROID__) || defined(TARGET_OS_IPHONE)
import <gpu>;

Gpu gpu;
GpuSurface surface;
bool live = false;
#endif

void App() {
    *GpuTouches touches = use_gpu_touches();
    *Signal<bool> ready = use_signal<bool>(false);
    use_gpu_surface(void(uint32 w, uint32 h) {
#if defined(__ANDROID__) || defined(TARGET_OS_IPHONE)
        if (live) { surface.release(); gpu.release(); live = false; }
        if (w != 0) {   // (0, 0): the surface went away (the app went to the background)
            gpu = gpu_open().value;
            surface = gpu_ui_surface(&gpu).value;
            live = true;
        }
#endif
        ready.set(w != 0);
    });
    use_frame(ready.get(), void(Tick tick) {
#if defined(__ANDROID__) || defined(TARGET_OS_IPHONE)
        int n = touches.count();   // fingers down; touches.down has each one's id and position
        GpuFrame frame = surface.frame().value;
        GpuPass pass = gpu.pass(frame.view, GpuColor{n > 0 ? 0.6 : 0.08, 0.08, 0.1, 1.0}, null);
        (void)pass.end();
        surface.present(&frame);
#endif
        touches.end_frame();
    });
    Column(Style{grow: 1}) {
        GpuView(Style{grow: 1});
        ButtonWith(Style{absolute: true, right: 24, bottom: 48}, "Attack") { /* ... */ }
    }
}
```

## Touches

A `GpuView` takes several fingers at once. `use_gpu_touch(fn(GpuTouch))` calls its handler
with each change: `id` (the same from down to up, reused by a later finger after that),
`phase` (`GPU_TOUCH_DOWN`, `GPU_TOUCH_MOVE`, `GPU_TOUCH_UP`, `GPU_TOUCH_CANCEL`), `x` and `y`
in pixels from the view's top left (the units of `use_gpu_surface`'s size) and `time` in
seconds. `use_gpu_touches()` keeps them as a `GpuTouches` for a game to read each frame:
`down` holds the fingers that are down in the order they went down (position, start position
and time, `began` for one that went down since the last frame), `released` those lifted or
cancelled since the last `end_frame`, so a tap between two frames is still seen. `find(id)`
gives one finger. When the surface goes away every finger is released as cancelled.
`<gpu/touch>` has the types and the state on their own, with no `<ui>` dependency.

Each finger goes to the view under it, so eskiu-ui controls placed over the `GpuView`
(`absolute` children after it) keep their own touches while other fingers move on the
view, and gestures elsewhere are unaffected. A finger that starts on the `GpuView` stays
its own even when it drags across a pan or scroll around it. Put a `GpuView` neither inside
a `Scroll` (iOS cancels its touches for the scroll) nor inside a `Pressable`.

On the web and in the desktop hosts `GpuView` is an empty box and `use_gpu_surface` never
fires, so the same app builds there; the WebGPU modules and `gpu_ui_surface` exist on iOS and
Android, hence the `#if`.
