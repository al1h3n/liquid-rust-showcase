//! `cargo run` serves the showcase: a tiny std-only static server for the repo root,
//! so `/www/` (the page and its wasm) and `/media/` are both reachable.
//!
//! Build the wasm first: `wasm-pack build --target web --release --out-dir www/pkg`.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::{env, fs, thread};

fn main() -> std::io::Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let listener = match env::args().nth(1) {
        // An explicit port must be that port.
        Some(port) => TcpListener::bind(format!("127.0.0.1:{port}")).map_err(|e| {
            eprintln!("port {port} is unavailable ({e}); try another: `cargo run -- <port>`");
            e
        })?,
        // Otherwise take the first free one from 8080 up.
        None => (8080..8100)
            .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok())
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::AddrInUse, "ports 8080–8099 are all in use"))?,
    };
    let port = listener.local_addr()?.port();
    if !root.join("www/pkg/liquid_rust_showcase_bg.wasm").exists() {
        eprintln!("www/pkg is missing: run `wasm-pack build --target web --release --out-dir www/pkg` first");
    }
    println!("LiquidRust showcase on http://127.0.0.1:{port}/");
    for stream in listener.incoming().flatten() {
        let root = root.clone();
        thread::spawn(move || {
            let _ = respond(stream, &root);
        });
    }
    Ok(())
}

fn respond(mut stream: TcpStream, root: &Path) -> std::io::Result<()> {
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line)?;
    let target = line.split_whitespace().nth(1).unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/");
    if path == "/" {
        return stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: /www/\r\nContent-Length: 0\r\n\r\n");
    }
    // Only plain relative components: no `..`, no drive prefixes.
    let relative: PathBuf = path.trim_start_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    if relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
    }
    let mut file = root.join(relative);
    if file.is_dir() {
        file.push("index.html");
    }
    match fs::read(&file) {
        Ok(body) => {
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\n\r\n",
                content_type(&file),
                body.len()
            );
            stream.write_all(head.as_bytes())?;
            stream.write_all(&body)
        }
        Err(_) => stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"),
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "wasm" => "application/wasm",
        "json" => "application/json",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "mp4" => "video/mp4",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}
