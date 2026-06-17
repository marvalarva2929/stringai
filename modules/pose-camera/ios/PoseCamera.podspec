Pod::Spec.new do |s|
  s.name           = 'PoseCamera'
  s.version        = '1.0.0'
  s.summary        = 'Real-time body pose detection with AVFoundation + Apple Vision + MediaPipe'
  s.author         = ''
  s.homepage       = 'https://expo.dev'
  s.platform       = :ios, '15.0'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency     'ExpoModulesCore'
  s.dependency     'MediaPipeTasksVision', '~> 0.10'
  s.source_files   = '*.swift'
  s.resources      = ['hand_landmarker.task']
  s.frameworks     = 'AVFoundation', 'Vision', 'Photos'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
  }
end
