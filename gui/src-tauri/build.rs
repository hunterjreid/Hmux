fn main() {
    // `HMUX_RELEASE` is what tells a build it came from the release workflow,
    // and it is read with `option_env!`, which is baked in at compile time.
    // Without this, flipping the variable would not invalidate the cached
    // build and a release could be cut from an object file that still thinks
    // it is somebody's working copy. See `is_release_build` in `main.rs`.
    println!("cargo:rerun-if-env-changed=HMUX_RELEASE");
    tauri_build::build()
}
