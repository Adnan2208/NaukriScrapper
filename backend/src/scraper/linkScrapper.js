const { chromium } = require('playwright');
const fs = require("fs");

async function getRenderedHtml(targetUrl) {
    // Launch a headless browser
    const browser = await chromium.launch({
        headless: false,
        // Mask user-agent to help bypass basic bot detection
        args: ['--disable-blink-features=AutomationControlled']
    });

    try {
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        const page = await context.newPage();

        // Navigate to the target page
        console.log(`Navigating to: ${targetUrl}...`);
        await page.goto(targetUrl, { 
            waitUntil: 'networkidle', 
            timeout: 60000 
        });

        // Extra wait to ensure client-side rendering (React/Angular/etc.) completes
        await page.waitForTimeout(3000);

        // Extract the fully rendered HTML markup
        const renderedHtml = await page.content();
        
        console.log("\n--- HTML extraction complete ---\n");
        return renderedHtml;

    } catch (error) {
        console.error("Error fetching rendered HTML:", error);
    } finally {
        await browser.close();
    }
}

// Example usage with Naukri
const url = 'https://www.naukri.com/software-developer-jobs?k=software%20developer&experience=0';

getRenderedHtml(url).then(html => {
    fs.writeFileSync("/home/adnan/Adnan/DT/NaukriScrapper/backend/data/renderedHTML.html",html);
});