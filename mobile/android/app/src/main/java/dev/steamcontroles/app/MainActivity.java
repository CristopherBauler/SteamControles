package dev.steamcontroles.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    stripWebViewMarker();
  }

  @Override
  public void onStart() {
    super.onStart();
    stripWebViewMarker();
  }

  private void stripWebViewMarker() {
    try {
      if (getBridge() == null) return;
      WebView webView = getBridge().getWebView();
      if (webView == null) return;
      WebSettings settings = webView.getSettings();
      String ua = settings.getUserAgentString();
      if (ua != null && ua.contains("; wv)")) {
        settings.setUserAgentString(ua.replace("; wv)", ")"));
      }
    } catch (Exception ignored) {
      // User-Agent extra; o capacitor.config já manda Chrome sem wv.
    }
  }
}
