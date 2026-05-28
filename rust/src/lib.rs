use wasm_bindgen::prelude::*;

pub const VERSION: &str = "v4-rust-0.1.0";

/// Returns the version string for this WASM build.
/// Used by the JS loader to confirm the module loaded successfully.
#[wasm_bindgen]
pub fn d4optimizer_version() -> String {
    VERSION.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_nonempty() {
        assert!(!d4optimizer_version().is_empty());
    }
}
