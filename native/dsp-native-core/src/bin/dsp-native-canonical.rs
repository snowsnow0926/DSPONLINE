use std::io::{self, Read};

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.first().map(String::as_str) == Some("--format-number") {
        let value = arguments
            .get(1)
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(f64::NAN);
        if !value.is_finite() {
            eprintln!("canonical number is invalid");
            std::process::exit(1);
        }
        let mut buffer = ryu_js::Buffer::new();
        println!("{}", buffer.format_finite(value));
        return;
    }
    let mut input = Vec::new();
    if let Err(error) = io::stdin().read_to_end(&mut input) {
        eprintln!("read canonical JSON input: {error}");
        std::process::exit(1);
    }
    match serde_json::from_slice::<serde_json::Value>(&input) {
        Ok(value)
            if arguments
                .iter()
                .any(|argument| argument == "--array-elements") =>
        {
            let Some(values) = value.as_array() else {
                eprintln!("canonical --array-elements input is not an array");
                std::process::exit(1);
            };
            for value in values {
                println!("{}", dsp_native_core::canonical::canonical_sha256(value));
            }
        }
        Ok(value) => println!("{}", dsp_native_core::canonical::canonical_sha256(&value)),
        Err(error) => {
            eprintln!("decode canonical JSON input: {error}");
            std::process::exit(1);
        }
    }
}
