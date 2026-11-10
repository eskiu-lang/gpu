# Window input

Keyboard, mouse, gamepads and touch in a `<gpu/window>` desktop window. Every kind of input
comes from `Window_poll` as a `WindowEvent`; gamepads can also be read once per frame. The
platform table is in the [docs index](README.md#platforms), and touch on iOS and Android is
in [docs/mobile.md](mobile.md).

API reference: [`<gpu/window>`](api.md#gpuwindow), [`<gpu/touch>`](api.md#gputouch).

## Events

`Window_poll` takes one event at a time; `ev.kind` says which fields are set:

| `kind` | Fields |
|---|---|
| `WINDOW_QUIT` | none |
| `WINDOW_RESIZE` | `width`, `height` (drawable pixels) |
| `WINDOW_KEY_DOWN`, `WINDOW_KEY_UP` | `key` (lowercase ASCII or a `KEY_` constant), `repeat` |
| `WINDOW_MOUSE_MOVE` | `x`, `y`, `dx`, `dy` (pixels), `from_touch` |
| `WINDOW_MOUSE_DOWN`, `WINDOW_MOUSE_UP` | `button` (1 left, 2 middle, 3 right), `x`, `y`, `from_touch` |
| `WINDOW_WHEEL` | `x`, `y` (scroll amounts) |
| `WINDOW_PAD_ADDED`, `WINDOW_PAD_REMOVED` | `pad` |
| `WINDOW_PAD_DOWN`, `WINDOW_PAD_UP` | `pad`, `button` (a `PAD_` button) |
| `WINDOW_PAD_AXIS` | `pad`, `axis` (a `PAD_AXIS_` axis), `value` |
| `WINDOW_TOUCH` | `touch` (a `GpuTouch`), `x`, `y` |

Positions are pixels from the top left of the drawable, the units of `Window_size` and of
the surface, also on a high-density display.

## Gamepads

`window_open` starts SDL's gamepad system. Each pad that is connected, at the start or
later, comes as a `WINDOW_PAD_ADDED` event with its `pad` id, which stays the same until
its `WINDOW_PAD_REMOVED`. SDL maps every pad it knows (Xbox, PlayStation, Switch and
hundreds of others, from its built-in controller database) to one standard layout, so a
button has the same `PAD_` name on any pad:

| Constant | Xbox | PlayStation | Switch |
|---|---|---|---|
| `PAD_SOUTH` | A | Cross | B |
| `PAD_EAST` | B | Circle | A |
| `PAD_WEST` | X | Square | Y |
| `PAD_NORTH` | Y | Triangle | X |
| `PAD_BACK` | View | Share, Create | Minus |
| `PAD_GUIDE` | Xbox | PS | Home |
| `PAD_START` | Menu | Options | Plus |
| `PAD_LEFT_STICK`, `PAD_RIGHT_STICK` | LS, RS | L3, R3 | stick clicks |
| `PAD_LEFT_SHOULDER`, `PAD_RIGHT_SHOULDER` | LB, RB | L1, R1 | L, R |
| `PAD_DPAD_UP`, `_DOWN`, `_LEFT`, `_RIGHT` | directional pad | directional pad | directional pad |
| `PAD_MISC` | Share | Mute | Capture |

The face buttons are named by position, so `PAD_SOUTH` is the bottom button on every pad
whatever its label. The axes are `PAD_AXIS_LEFT_X`, `_LEFT_Y`, `_RIGHT_X` and `_RIGHT_Y`,
from -1 to 1 with y positive **down**, and `PAD_AXIS_LEFT_TRIGGER` and `_RIGHT_TRIGGER`
(LT and RT, L2 and R2, ZL and ZR), from 0 to 1.

For a game, reading the pads once per frame is usually simpler than following their events.
`Window_pad_state` fills a `PadState` with the buttons held and the axes, after the
`Window_poll` loop of the frame:

```eskiu
WindowEvent ev;
while (win.poll(&ev)) {
    if (ev.kind == WINDOW_PAD_ADDED) printf("connected: %s\n", win.pad_name(ev.pad));
}
PadState pad;
win.pad_state(PAD_ANY, &pad);
bool down = pad.held(PAD_DPAD_DOWN) || pad.left_y > 0.5;
bool up = pad.held(PAD_DPAD_UP) || pad.left_y < -0.5;
bool confirm = pad.held(PAD_SOUTH);
bool cancel = pad.held(PAD_EAST);
```

`PAD_ANY` reads every connected pad as one: a button is held when it is held on any of
them, and each axis is the one farthest from rest. A pad's own id reads only that pad, for
local multiplayer (`Window_pad_count` and `Window_pad_id` list them). `Window_pad_state`
returns false when the pad, or with `PAD_ANY` every pad, is gone.

The sticks have a radial deadzone, 0.1 to start with and set with
`Window_set_pad_deadzone`: a stick within that distance of the center reads as centered,
and past it the rest of its travel is stretched to the full range, so a stick barely
pushed past the deadzone reads close to 0 and one pushed all the way reads 1. The triggers
get the same deadzone. `WINDOW_PAD_AXIS` events carry the raw value with no deadzone.

`Window_pad_rumble(pad, low, high, ms)` runs the pad's motors, the low-frequency (left,
heavier) one at `low` and the high-frequency (right) one at `high`, both from 0 to 1, for
`ms` milliseconds; it returns false when the pad has no motors. A new call replaces the
running one, and `0, 0` stops it.

### Coming from gilrs

The names of the Rust `gilrs` crate map one to one, apart from the direction of the y axes:

| gilrs | `<gpu/window>` |
|---|---|
| `Button::South`, `East`, `West`, `North` | `PAD_SOUTH`, `PAD_EAST`, `PAD_WEST`, `PAD_NORTH` |
| `Button::Select`, `Mode`, `Start` | `PAD_BACK`, `PAD_GUIDE`, `PAD_START` |
| `Button::LeftTrigger`, `RightTrigger` (the bumpers) | `PAD_LEFT_SHOULDER`, `PAD_RIGHT_SHOULDER` |
| `Button::LeftTrigger2`, `RightTrigger2` | `PadState.left_trigger`, `right_trigger` |
| `Button::LeftThumb`, `RightThumb` | `PAD_LEFT_STICK`, `PAD_RIGHT_STICK` |
| `Button::DPadUp`, `DPadDown`, `DPadLeft`, `DPadRight` | `PAD_DPAD_UP`, `PAD_DPAD_DOWN`, `PAD_DPAD_LEFT`, `PAD_DPAD_RIGHT` |
| `Axis::LeftStickX`, `RightStickX` | `PadState.left_x`, `right_x` |
| `Axis::LeftStickY`, `RightStickY` (positive up) | `-PadState.left_y`, `-right_y` (positive down) |
| `Gilrs::gamepads()` with `is_pressed` on each | `Window_pad_state(PAD_ANY)` |

## Touch

A finger on a touch screen or trackpad that reports touches, or a pen, comes as a
`WINDOW_TOUCH` event whose `touch` is the same `GpuTouch` a mobile `GpuView` gives: a small
`id` that stays the same from `GPU_TOUCH_DOWN` to `GPU_TOUCH_UP` or `GPU_TOUCH_CANCEL` and is
reused by a later finger (the smallest id not in use), the `phase`, `x` and `y` in pixels,
and `time` in seconds. A `GpuTouches` follows the fingers that are down across frames, as
on a phone, so one touch interface runs on both:

```eskiu
GpuTouches touches;
defer touches.free();
win.set_mouse_touch(true);   // the left mouse button acts as a finger, for testing
while (running) {
    while (win.poll(&ev)) {
        if (ev.kind == WINDOW_TOUCH) touches.apply(ev.touch);
    }
    for (i in 0..touches.down.size) { GpuTouchPoint p = touches.down.data[i]; ... }
    touches.end_frame();
}
```

`Window_set_mouse_touch(true)` turns the left mouse button into a finger: its press, the
motion while it is held and its release come as `WINDOW_TOUCH` instead of mouse events,
alongside any real fingers. Motion with no button held, the other buttons and the wheel stay
mouse events, so hovering still works.

The system also turns a finger on a touch screen into mouse events, for programs that read
only the mouse. Those come too, with `from_touch` set, so a program that handles
`WINDOW_TOUCH` skips the mouse events that have it.

## In a browser

On the web, keys, the mouse and the wheel come from the page. Gamepads and fingers are not
read there yet: `Window_pad_count` is 0, `Window_pad_state` returns false and no
`WINDOW_TOUCH` comes, except from the mouse with `Window_set_mouse_touch`.
