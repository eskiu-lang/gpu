// <gpu/ui> on Android: holds the mounted GpuView's ANativeWindow* for
// Gpu_surface_android (src/ui.esk).
#include <jni.h>
#include <android/native_window_jni.h>
#include "ui_native.h"

static ANativeWindow *live_window = NULL;
static int live_width = 0;
static int live_height = 0;

JNIEXPORT void JNICALL Java_org_eskiu_gpu_GpuView_nativeSetSurface(
    JNIEnv *env, jclass cls, jobject surface, jint width, jint height) {
    (void)cls;
    if (live_window != NULL) {
        ANativeWindow_release(live_window);
        live_window = NULL;
    }
    if (surface != NULL && width > 0 && height > 0) {
        live_window = ANativeWindow_fromSurface(env, surface);
        live_width = (int)width;
        live_height = (int)height;
    } else {
        live_width = 0;
        live_height = 0;
    }
}

void *gpu_ui_native_handle(int *width, int *height) {
    if (width) *width = live_width;
    if (height) *height = live_height;
    return (void *)live_window;
}
