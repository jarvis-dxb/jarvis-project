if (!window.alertSound) {
    window.alertSound = null;
}

window.getOrCreateOverlay = () => {
    let overlay = document.getElementById('alert-click-overlay');
    if (!overlay) {
        overlay = document.createElement('button');
        overlay.id = 'alert-click-overlay';
        overlay.type = 'button';
        overlay.setAttribute('aria-label', 'Stop trading alert');
        overlay.textContent = 'Stop alert';
        overlay.title = 'Stop the trading alert sound';
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === 'Escape' || event.key === ' ') window.stopAlert();
        });
        // Keep the workspace clear and interactive while an alert is sounding.
        overlay.style.cssText = 'display: none; position: fixed; right: 16px; bottom: calc(72px + env(safe-area-inset-bottom, 0px)); z-index: 1000; max-width: calc(100vw - 32px); min-height: 40px; padding: 8px 14px; border: 1px solid var(--border, #284260); border-radius: 10px; color: var(--foreground, #edf3ff); background: var(--card, #0e1d32); box-shadow: 0 4px 16px #0003; cursor: pointer; font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1.4;';
        overlay.addEventListener('click', () => {
            window.stopAlert();
        });
        if (document.body) {
            document.body.appendChild(overlay);
        } else {
            window.addEventListener('DOMContentLoaded', () => {
                document.body.appendChild(overlay);
            });
        }
    }
    return overlay;
};

window.enableAlerts = async () => {
    if (!("Notification" in window)) {
        console.log("This browser does not support desktop notifications");
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        console.log("Notification permission:", permission);

        if (permission === "granted" && window.alertSound) {
            window.alertSound.play();
            window.alertSound.pause();
        }
    } catch (err) {
        console.log("Error in enableAlerts:", err);
    }
}

window.initSound = () => {
    if (window.alertSound !== null) return;

    window.alertSound = new Howl({
        src: ['https://cdn.jsdelivr.net/gh/mohd7469/chart@main/3/beep.mp3'],
        loop: true,
        volume: 1,
        html5: false,
        autoplay: false,
        onplayerror: () => {
            window.alertSound.once('unlock', () => window.alertSound.play());
        }
    });

    // Audio unlocks through the first user gesture; keep the workspace usable at startup.
};

window.playAlert = () => {
    if (!window.alertSound) window.initSound();

    if (!window.alertSound.playing()) {
        window.alertSound.play();
        const overlay = window.getOrCreateOverlay();
        if (overlay) overlay.style.display = 'block';
    }
};

window.stopAlert = () => {
    if (window.alertSound) {
        window.alertSound.stop();
    }
    const overlay = document.getElementById('alert-click-overlay');
    if (overlay) overlay.style.display = 'none';
};

window.initSound();
