import { useEffect, useRef, useState } from "react";
import { useSource } from "./useSource";
import { blockByHeading, formatBytes, releaseNoteLines, segmentsFromLines } from "./format";

const MAIN_SITE_URL = "https://armsx2.net";
const CHECKSUMS_ROUTE = "#/checksums";
const MANUAL_ROUTE = "#/manual";
const SCREENSHOT_CAPTIONS = ["Library", "Settings", "Gameplay"];

const detectIOS = () => {
  if (typeof navigator === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent || "";
  const isIOSDevice = /iPad|iPhone|iPod/.test(userAgent);
  const isIPadOS = navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1;
  return isIOSDevice || isIPadOS;
};

const SECTIONS = [
  { id: "top", label: "Home" },
  { id: "guides", label: "Requirements" },
];

const SideDots = () => {
  const [active, setActive] = useState(SECTIONS[0].id);

  useEffect(() => {
    let ticking = false;
    const update = () => {
      ticking = false;
      const line = window.innerHeight * 0.35;
      let current = SECTIONS[0].id;
      for (const { id } of SECTIONS) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top - line <= 0) {
          current = id;
        }
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <nav className="side-dots" aria-label="Page sections">
      {SECTIONS.map(({ id, label }) => (
        <a
          key={id}
          href={`#${id}`}
          className={`side-dot ${active === id ? "active" : ""}`}
          aria-label={`Go to ${label}`}
          aria-current={active === id ? "true" : "false"}
        />
      ))}
    </nav>
  );
};

const Footer = () => {
  const year = new Date().getFullYear();
  return (
    <footer className="site-footer">
      <span>©{year} ARMSX2 All rights reserved, site by </span>
      <a href="https://github.com/medievalshell" target="_blank" rel="noopener noreferrer">medievalshell</a>
      <span className="footer-sep">•</span>
      <a href="https://armsx2.net/contact">Contact Us</a>
    </footer>
  );
};

const ChecksumsPage = () => {
  const [state, setState] = useState({ loading: true, error: null, payload: null });
  const [copied, setCopied] = useState("");

  useEffect(() => {
    window.scrollTo(0, 0);
    let cancelled = false;
    fetch(new URL("checksums.json", document.baseURI).href, {
      headers: { Accept: "application/json" },
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Request failed: ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        if (!cancelled) {
          setState({ loading: false, error: null, payload });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ loading: false, error: error.message, payload: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const files = state.payload?.files || [];
  const generatedAt = state.payload?.generatedAt;

  const copySha = async (sha) => {
    try {
      await navigator.clipboard.writeText(sha);
      setCopied(sha);
    } catch (error) {
      console.error("Failed to copy checksum:", error);
    }
  };

  return (
    <div className="page subpage">
      <p className="section-kicker">Integrity</p>
      <h1>Checksums</h1>
      <p className="subtitle">Verify your download against the published SHA-256 hashes.</p>
      {generatedAt && <p className="note">Generated {generatedAt.slice(0, 10)}</p>}

      {state.loading ? (
        <p className="note" style={{ marginTop: "24px" }}>Loading checksums…</p>
      ) : state.error ? (
        <p className="note" style={{ marginTop: "24px" }}>Checksums could not be loaded: {state.error}</p>
      ) : files.length === 0 ? (
        <p className="note" style={{ marginTop: "24px" }}>No checksums are available yet.</p>
      ) : (
        <div className="checksum-list">
          {files.map((file) => (
            <div className="checksum-card" key={file.fileName}>
              <div className="checksum-head">
                <strong>{file.fileName}</strong>
                <span className="checksum-meta">
                  {[
                    file.version && `v${file.version}`,
                    file.buildVersion && `Build ${file.buildVersion}`,
                    file.date,
                    Number.isFinite(file.size) && formatBytes(file.size),
                  ].filter(Boolean).join(" · ")}
                </span>
              </div>
              <div className="checksum-sha">
                <span className="panel-label">SHA-256</span>
                <code>{file.sha256 || "unavailable"}</code>
                {file.sha256 && (
                  <button type="button" onClick={() => copySha(file.sha256)}>
                    {copied === file.sha256 ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Footer />
    </div>
  );
};

const Segments = ({ segments }) =>
  segments.map((segment, index) =>
    segment.type === "p" ? (
      <p key={index}>{segment.text}</p>
    ) : (
      <ul key={index} className="detail-list">
        {segment.items.map((item, itemIndex) => (
          <li key={itemIndex}>{item}</li>
        ))}
      </ul>
    ),
  );

const FeatureList = ({ status, blocks }) => {
  if (status === "error") {
    return "apps.json could not be loaded.";
  }
  if (status !== "ready") {
    return null;
  }
  const featuresBlock = blockByHeading(blocks, "Features");
  const segments = featuresBlock ? segmentsFromLines(featuresBlock.lines) : [];
  if (!segments.length) {
    return "Feature details are temporarily unavailable.";
  }
  return <Segments segments={segments} />;
};

const LegalDetails = ({ status, blocks }) => {
  if (status === "error") {
    return "apps.json could not be loaded.";
  }
  if (status !== "ready") {
    return null;
  }
  const legalBlocks = ["Disclaimer", "Credits"]
    .map((heading) => blockByHeading(blocks, heading))
    .filter(Boolean);
  if (!legalBlocks.length) {
    return "Legal and credit details are temporarily unavailable.";
  }
  return legalBlocks.map((block, index) => (
    <div key={index}>
      {block.heading && <h3>{block.heading}</h3>}
      <Segments segments={segmentsFromLines(block.lines)} />
    </div>
  ));
};

const WhatsNew = ({ status, releaseNotes }) => {
  if (status === "error") {
    return "apps.json could not be loaded.";
  }
  if (status !== "ready") {
    return null;
  }
  const lines = releaseNoteLines(releaseNotes);
  if (!lines.length) {
    return "Release notes are temporarily unavailable.";
  }
  return (
    <>
      <p>{lines[0]}</p>
      {lines.length > 1 && (
        <ul className="change-list">
          {lines.slice(1).map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </>
  );
};

const Carousel = ({ images }) => {
  const [index, setIndex] = useState(0);
  const [zoom, setZoom] = useState(null);
  const startX = useRef(0);
  const moved = useRef(false);
  const count = images.length;

  useEffect(() => {
    if (count <= 1 || zoom !== null) {
      return undefined;
    }
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % count);
    }, 5000);
    return () => clearInterval(timer);
  }, [count, zoom]);

  useEffect(() => {
    if (zoom === null) {
      return undefined;
    }
    const onKey = (event) => {
      if (event.key === "Escape") setZoom(null);
      else if (event.key === "ArrowRight") setZoom((z) => (z + 1) % count);
      else if (event.key === "ArrowLeft") setZoom((z) => (z - 1 + count) % count);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [zoom, count]);

  if (!count) {
    return null;
  }

  const go = (delta) => setIndex((current) => (current + delta + count) % count);
  const zoomGo = (delta) => setZoom((z) => (z + delta + count) % count);

  const onTouchStart = (event) => {
    startX.current = event.touches[0].clientX;
    moved.current = false;
  };
  const onTouchMove = () => {
    moved.current = true;
  };
  const onTouchEnd = (event) => {
    if (!moved.current) {
      return;
    }
    const dx = event.changedTouches[0].clientX - startX.current;
    if (Math.abs(dx) > 40) {
      go(dx < 0 ? 1 : -1);
    }
  };

  const slideClick = (positionClass, slideIndex) => {
    if (positionClass === "pos-0") setZoom(slideIndex);
    else if (positionClass === "pos-1") go(1);
    else if (positionClass === "pos-last") go(-1);
  };

  return (
    <>
      <div className="carousel">
        <div
          className="carousel-stage"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {images.map((src, slideIndex) => {
            const pos = (slideIndex - index + count) % count;
            let positionClass = "pos-hidden";
            if (pos === 0) {
              positionClass = "pos-0";
            } else if (pos === 1) {
              positionClass = "pos-1";
            } else if (pos === count - 1) {
              positionClass = "pos-last";
            }
            return (
              <div
                key={src}
                className={`carousel-slide ${positionClass}`}
                onClick={() => slideClick(positionClass, slideIndex)}
              >
                <img
                  src={src}
                  alt={SCREENSHOT_CAPTIONS[slideIndex] || `Screenshot ${slideIndex + 1}`}
                  loading={slideIndex === 0 ? "eager" : "lazy"}
                  decoding="async"
                />
              </div>
            );
          })}
          {count > 1 && (
            <>
              <button type="button" className="carousel-arrow prev" aria-label="Previous screenshot" onClick={() => go(-1)}>‹</button>
              <button type="button" className="carousel-arrow next" aria-label="Next screenshot" onClick={() => go(1)}>›</button>
            </>
          )}
        </div>
        {count > 1 && (
          <div className="carousel-dots">
            {images.map((src, dotIndex) => (
              <span key={src} className={`carousel-dot ${dotIndex === index ? "active" : ""}`} />
            ))}
          </div>
        )}
        <p className="carousel-caption">{SCREENSHOT_CAPTIONS[index] || `Screenshot ${index + 1}`}</p>
      </div>

      {zoom !== null && (
        <div className="lightbox" role="dialog" aria-modal="true" onClick={() => setZoom(null)}>
          <button type="button" className="lightbox-close" aria-label="Close" onClick={() => setZoom(null)}>✕</button>
          {count > 1 && (
            <button type="button" className="lightbox-arrow prev" aria-label="Previous" onClick={(event) => { event.stopPropagation(); zoomGo(-1); }}>‹</button>
          )}
          <img
            src={images[zoom]}
            alt={SCREENSHOT_CAPTIONS[zoom] || `Screenshot ${zoom + 1}`}
            onClick={(event) => event.stopPropagation()}
          />
          {count > 1 && (
            <button type="button" className="lightbox-arrow next" aria-label="Next" onClick={(event) => { event.stopPropagation(); zoomGo(1); }}>›</button>
          )}
        </div>
      )}
    </>
  );
};

const LoadingSurface = () => <span className="loading-surface" aria-hidden="true">&nbsp;</span>;

const ManualPage = () => {
  const { loading, source, canonicalSourceUrl } = useSource();
  const [status, setStatus] = useState("");

  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  const copyLink = async () => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API is unavailable.");
      }
      await navigator.clipboard.writeText(canonicalSourceUrl);
      setStatus("Source URL copied.");
    } catch (error) {
      console.error("Failed to copy source URL:", error);
      setStatus("Copy failed.");
    }
  };

  return (
    <div className="page subpage">
      <p className="section-kicker">Install</p>
      <h1>Manual installation</h1>
      <p className="subtitle">
        Add the ARMSX2 iOS source to your sideloader, then install the latest build
        {source?.version ? ` (v${source.version})` : ""}.
      </p>

      <div className="manual-source" style={{ marginTop: "28px", maxWidth: "640px" }}>
        <p className="panel-label">Source URL</p>
        <div className="source-url">
          <code>{loading ? "Loading source URL…" : canonicalSourceUrl}</code>
          <button
            className="source-copy"
            type="button"
            onClick={copyLink}
            aria-label="Copy source URL"
            title="Copy source URL"
          >
            <span className="visually-hidden">Copy source URL</span>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
              <path d="M8 8.5A2.5 2.5 0 0 1 10.5 6h6A2.5 2.5 0 0 1 19 8.5v6a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 8 14.5v-6Z" stroke="currentColor" strokeWidth="1.8" />
              <path d="M6 13.5h-.5A2.5 2.5 0 0 1 3 11V5.5A2.5 2.5 0 0 1 5.5 3H11a2.5 2.5 0 0 1 2.5 2.5V6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <p className="status" aria-live="polite">{status}</p>
      </div>

      <div className="manual-steps">
        <div className="manual-method">
          <h3>LiveContainer</h3>
          <ol>
            <li>Install LiveContainer 3.7.0 or later.</li>
            <li>Open LiveContainer and add a new app source.</li>
            <li>Paste the source URL above and confirm.</li>
            <li>Install ARMSX2 iOS, then enable JIT before launching.</li>
          </ol>
        </div>
        <div className="manual-method">
          <h3>SideStore</h3>
          <ol>
            <li>Open SideStore and go to the Sources tab.</li>
            <li>Tap add source and paste the URL above.</li>
            <li>Open the source and install ARMSX2 iOS.</li>
            <li>Enable JIT from SideStore for playable performance.</li>
          </ol>
        </div>
        <div className="manual-method">
          <h3>Feather</h3>
          <ol>
            <li>Open Feather and go to Sources.</li>
            <li>Add a source and paste the URL above.</li>
            <li>Install ARMSX2 iOS from the source.</li>
            <li>Use a JIT-capable setup before launching.</li>
          </ol>
        </div>
      </div>

      <div className="copy-block" style={{ marginTop: "30px", maxWidth: "640px" }}>
        <h3>Requirements</h3>
        <ul className="detail-list">
          <li>{source?.minOSVersion ? `iOS ${source.minOSVersion} or later.` : "A recent iOS version is required."}</li>
          <li>A JIT-capable setup is required for playable performance.</li>
          <li>ARMSX2 does not include games or BIOS files; bring your own legally obtained PS2 BIOS and game backups.</li>
        </ul>
      </div>

      <Footer />
    </div>
  );
};

const MainPage = () => {
  const { loading, error, source, canonicalSourceUrl } = useSource();
  const [isIOS] = useState(detectIOS);
  const [status, setStatus] = useState("");

  const phase = loading ? "loading" : error ? "error" : "ready";

  useEffect(() => {
    if (error) {
      setStatus(`Install details could not be loaded: ${error}`);
    }
  }, [error]);

  const openScheme = (scheme) => {
    window.location.href = `${scheme}://source?url=${encodeURIComponent(canonicalSourceUrl)}`;
  };

  const metric = (value) => (phase === "ready" ? value : phase === "error" ? "Unavailable" : "Loading");

  return (
    <div className="page">
      <SideDots />

      <main>
        <section className="hero" id="top" aria-labelledby="app-title">
          <div className="hero-copy">
            <div className="identity">
              <img className="app-icon" src={source?.iconURL || "/assets/icon.png"} alt="" />
              <div>
                <p className="platforms">LiveContainer / SideStore / Feather</p>
                <h1 id="app-title">{source?.appName || "ARMSX2 iOS"}</h1>
              </div>
            </div>
            <p className="subtitle">
              {phase === "ready" ? source.subtitle
                : phase === "error" ? "Install details are temporarily unavailable."
                : <LoadingSurface />}
            </p>
            <p className="hero-description">
              {phase === "ready" ? source.heroDescription
                : phase === "error" ? "Try again in a moment or copy the install link manually."
                : <LoadingSurface />}
            </p>
            <div className="hero-actions">
              <button
                type="button"
                className="hero-btn hero-btn--purple"
                onClick={() => { window.location.hash = "/manual"; }}
              >
                Manual install
              </button>
              <button
                type="button"
                className="hero-btn hero-btn--blue"
                onClick={() => { window.location.hash = "/checksums"; }}
              >
                View checksums
              </button>
            </div>
          </div>

          <aside className="install-panel" aria-label="Install options">
            <div className="metrics" aria-label="Latest version">
              <div className="metric">
                <span>Version</span>
                <strong>{metric(source?.version)}</strong>
              </div>
              <div className="metric">
                <span>Updated</span>
                <strong>{metric(source?.date)}</strong>
              </div>
              <div className="metric">
                <span>Minimum iOS</span>
                <strong>{metric(source?.minOSVersion)}</strong>
              </div>
            </div>

            <div className="install-actions" aria-label="Install actions">
              <button className="primary-action" type="button" onClick={() => openScheme("livecontainer")}>
                Install via LiveContainer
              </button>
              <div className="secondary-actions">
                <button type="button" className="hero-btn hero-btn--blue" onClick={() => openScheme("sidestore")}>SideStore</button>
                <button type="button" className="hero-btn hero-btn--blue" onClick={() => openScheme("feather")}>Feather</button>
              </div>
              {!isIOS && (
                <button type="button" className="hero-btn hero-btn--blue" onClick={() => { window.location.href = MAIN_SITE_URL; }}>
                  Home
                </button>
              )}
            </div>

            <p className="note">
              {isIOS
                ? "LiveContainer is recommended for first-time installs."
                : "Install buttons work on iPhone or iPad. On other devices, get ARMSX2 from the main site."}
            </p>
            <p className="status" aria-live="polite">{status}</p>
          </aside>

          {phase === "ready" && source.screenshotURLs?.length > 0 && (
            <Carousel images={source.screenshotURLs} />
          )}
        </section>

        <div className="priority-grid" id="guides">
          <section className="section" id="requirements" aria-labelledby="requirements-title">
            <p className="section-kicker">Before You Install</p>
            <h2 id="requirements-title">Requirements</h2>
            <ul className="requirement-list">
              <li>
                {phase === "ready"
                  ? source.minOSRequirementText
                  : "Minimum iOS version loads from apps.json."}
              </li>
              <li>A <a href="https://livecontainer.github.io/docs/guides/jit-support" target="_blank" rel="noopener noreferrer">JIT-capable setup</a> is needed for playable performance.</li>
              <li>LiveContainer automatic import requires LiveContainer 3.7.0 or later.</li>
              <li>ARMSX2 does not include games or BIOS files.</li>
              <li>You need your own legally obtained PS2 BIOS and game backups, such as ISO files.</li>
            </ul>
          </section>

          <section className="section" id="features" aria-labelledby="features-title">
            <p className="section-kicker">Core Features</p>
            <h2 id="features-title">Built for PS2 on iOS</h2>
            <div className="copy-block">
              <FeatureList status={phase} blocks={source?.descriptionBlocks || []} />
            </div>
          </section>
        </div>

        <div className="content-grid" id="details">
          <section className="section" id="whats-new" aria-labelledby="whats-new-title">
            <p className="section-kicker">Latest Update</p>
            <h2 id="whats-new-title">What&rsquo;s New</h2>
            <p className="version-line">
              {phase === "ready" ? source.whatsNewVersionLabel
                : phase === "error" ? "Release notes unavailable"
                : "Loading release notes"}
            </p>
            <div className="copy-block">
              <WhatsNew status={phase} releaseNotes={source?.releaseNotes} />
            </div>
          </section>

          <section className="section legal-section" id="checksums" aria-labelledby="legal-title">
            <p className="section-kicker">Trust</p>
            <h2 id="legal-title">Legal &amp; Credits</h2>
            <div className="copy-block">
              <LegalDetails status={phase} blocks={source?.descriptionBlocks || []} />
            </div>
          </section>
        </div>
      </main>

      <Footer />
    </div>
  );
};

const SiteLogo = () => (
  <a href="#top" className="site-logo" aria-label="Back to home">
    <img src="/icon.png" alt="ARMSX2" />
  </a>
);

const App = () => {
  const [route, setRoute] = useState(() => (typeof window !== "undefined" ? window.location.hash : ""));

  useEffect(() => {
    const onHashChange = () => setRoute(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const page =
    route === CHECKSUMS_ROUTE ? <ChecksumsPage />
      : route === MANUAL_ROUTE ? <ManualPage />
        : <MainPage />;

  return (
    <>
      <SiteLogo />
      {page}
    </>
  );
};

export default App;
