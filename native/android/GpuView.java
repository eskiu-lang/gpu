// <gpu/ui> on Android: a SurfaceView for NativeView("gpu") whose ANativeWindow*
// is handed to wgpuInstanceCreateSurface through gpu_ui_native_handle (gpu.c).
package org.eskiu.gpu;

import android.content.Context;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import org.eskiu.ui.UiActivity;

public final class GpuView extends SurfaceView implements SurfaceHolder.Callback {
    private final UiActivity.ViewEvents events;

    public static void setup() {
        UiActivity.registerView("gpu", new UiActivity.ViewFactory() {
            @Override public View create(Context context, UiActivity.ViewEvents events) {
                return new GpuView(context, events);
            }
            @Override public void set(View view, String name, String value) {}
        });
    }

    private static native void nativeSetSurface(Surface surface, int width, int height);

    GpuView(Context context, UiActivity.ViewEvents events) {
        super(context);
        this.events = events;
        getHolder().addCallback(this);
    }

    @Override public void surfaceCreated(SurfaceHolder holder) {
        int w = getWidth();
        int h = getHeight();
        nativeSetSurface(holder.getSurface(), w, h);
        if (w > 0 && h > 0) {
            if (events != null) events.emit("resize", w + " " + h);
            UiActivity.emit("gpu", "resize " + w + " " + h);
        }
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        nativeSetSurface(holder.getSurface(), width, height);
        if (width > 0 && height > 0) {
            if (events != null) events.emit("resize", width + " " + height);
            UiActivity.emit("gpu", "resize " + width + " " + height);
        }
    }

    @Override public void surfaceDestroyed(SurfaceHolder holder) {
        nativeSetSurface(null, 0, 0);
        if (events != null) events.emit("destroy", "");
        UiActivity.emit("gpu", "destroy");
    }
}
