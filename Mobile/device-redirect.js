/**
 * Device Detection and Redirect Script (Mobile Version)
 * Automatically routes users to the appropriate version based on their device
 */

(function() {
  // Function to detect if device is an iPhone or mobile device
  function getDeviceType() {
    const ua = navigator.userAgent || navigator.vendor || window.opera;
    
    // Check for iPhone
    const isIPhone = /iPhone|iPad|iPod/.test(ua) && !window.MSStream;
    
    // Check for other mobile devices
    const isMobile = /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    
    return {
      isIPhone: isIPhone,
      isMobile: isMobile,
      isMobileDevice: isIPhone || isMobile
    };
  }
  
  // Function to redirect to appropriate version
  function redirectIfNeeded() {
    const device = getDeviceType();
    
    // If on desktop, redirect to Computer version
    if (!device.isMobileDevice) {
      window.location.href = '../Computer/';
    }
  }
  
  // Run redirect check when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', redirectIfNeeded);
  } else {
    redirectIfNeeded();
  }
})();
