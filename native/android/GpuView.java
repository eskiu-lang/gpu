// <gpu/ui> on Android: a SurfaceView for NativeView("gpu") whose ANativeWindow*
// is handed to wgpuInstanceCreateSurface through gpu_ui_native_handle (gpu.c). Its touches
// go on the "gpu" channel as "touch TIME_MS COUNT (ID PHASE X Y)..." (<gpu/touch>).
package org.eskiu.gpu;

import android.content.Context;
import android.view.MotionEvent;
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

    // One payload per MotionEvent: Android already batches moves to one per frame, and a move
    // carries every pointer. Positions are the view's pixels, as the surface's size.
    @Override public boolean onTouchEvent(MotionEvent e) {
        int action = e.getActionMasked();
        int phase;
        boolean all;
        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN: phase = 0; all = false; break;
            case MotionEvent.ACTION_MOVE: phase = 1; all = true; break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP: phase = 2; all = false; break;
            case MotionEvent.ACTION_CANCEL: phase = 3; all = true; break;
            default: return true;
        }
        // The view keeps its fingers: a scroll or pan around it does not take them over.
        if (action == MotionEvent.ACTION_DOWN && getParent() != null) getParent().requestDisallowInterceptTouchEvent(true);
        StringBuilder out = new StringBuilder("touch ").append(e.getEventTime());
        if (all) {
            int count = e.getPointerCount();
            out.append(' ').append(count);
            for (int i = 0; i < count; i++) appendPointer(out, e, i, phase);
        } else {
            out.append(" 1");
            appendPointer(out, e, e.getActionIndex(), phase);
        }
        UiActivity.emit("gpu", out.toString());
        return true;
    }

    private static void appendPointer(StringBuilder out, MotionEvent e, int index, int phase) {
        out.append(' ').append(e.getPointerId(index)).append(' ').append(phase)
            .append(' ').append(Math.round(e.getX(index))).append(' ').append(Math.round(e.getY(index)));
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
